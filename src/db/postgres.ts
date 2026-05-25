import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/env';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Aurora password lives in Secrets Manager (rotated by RDS). The pool's password
// is an async function so each new connection picks up the current secret — no
// .env edit or redeploy needed when the secret rotates.

let pool: Pool | null = null;
let smClient: SecretsManagerClient | null = null;
let cachedSecret: { username: string; password: string } | null = null;
let cachedAt = 0;
const SECRET_TTL_MS = 5 * 60 * 1000;

function getSecretsClient(): SecretsManagerClient {
  if (!smClient) {
    smClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return smClient;
}

async function fetchDbSecret(): Promise<{ username: string; password: string }> {
  const arn = process.env.DB_SECRET_ARN;
  if (!arn) throw new Error('DB_SECRET_ARN is not configured');
  if (cachedSecret && Date.now() - cachedAt < SECRET_TTL_MS) return cachedSecret;
  const res = await getSecretsClient().send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('DB secret has no SecretString');
  const parsed = JSON.parse(res.SecretString) as { username: string; password: string };
  cachedSecret = parsed;
  cachedAt = Date.now();
  return parsed;
}

function invalidateSecretCache() {
  cachedSecret = null;
  cachedAt = 0;
}

export function isPostgresConfigured(): boolean {
  return Boolean(process.env.DB_SECRET_ARN || config.postgresUrl);
}

export function getPostgresPool(): Pool | null {
  if (!isPostgresConfigured()) return null;
  if (pool) return pool;

  const sslConfig =
    process.env.POSTGRES_SSL === 'false'
      ? false
      : { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === 'true' };
  const max = Number(process.env.POSTGRES_POOL_MAX || 8);

  if (process.env.DB_SECRET_ARN) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      database: process.env.DB_NAME || 'unieconnect_oms',
      password: async () => (await fetchDbSecret()).password,
      ssl: sslConfig,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  } else {
    pool = new Pool({
      connectionString: config.postgresUrl,
      ssl: sslConfig,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  pool.on('error', (err: any) => {
    if (err && err.code === '28P01') invalidateSecretCache();
  });

  return pool;
}

export async function pgQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T> | null> {
  const pg = getPostgresPool();
  if (!pg) return null;
  try {
    return await pg.query<T>(text, values);
  } catch (err: any) {
    if (err && err.code === '28P01') invalidateSecretCache();
    throw err;
  }
}

export async function withPgTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T | null> {
  const pg = getPostgresPool();
  if (!pg) return null;
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error: any) {
    if (error && error.code === '28P01') invalidateSecretCache();
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
  }
}
