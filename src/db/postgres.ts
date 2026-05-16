import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/env';

let pool: Pool | null = null;

export function isPostgresConfigured(): boolean {
  return Boolean(config.postgresUrl);
}

export function getPostgresPool(): Pool | null {
  if (!config.postgresUrl) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: config.postgresUrl,
      ssl:
        process.env.POSTGRES_SSL === 'false'
          ? false
          : {
              rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === 'true',
            },
      max: Number(process.env.POSTGRES_POOL_MAX || 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export async function pgQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T> | null> {
  const pg = getPostgresPool();
  if (!pg) return null;
  return pg.query<T>(text, values);
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
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
