import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import fetch from 'node-fetch';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

type CortexCredentialRow = {
  id: string;
  user_id: string;
  cortex_credential_id: string | null;
  cortex_tenant_key: string | null;
  api_username: string;
  secret_enc: string | null;
  secret_prefix: string | null;
  scopes: string[];
  model_settings: Record<string, unknown>;
  status: string;
  provisioning_error: string | null;
  last_verified_at: Date | string | null;
  last_used_at: Date | string | null;
  cortex_engagement_id: string | null;
  intelligence_tier: string | null;
  next_intelligence_run_at: Date | string | null;
  last_intelligence_run_at: Date | string | null;
};

type AppUserRow = {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  llc_name?: string | null;
};

function encryptionKey(): Buffer {
  return createHash('sha256')
    .update(process.env.OMS_CORTEX_CREDENTIAL_ENCRYPTION_KEY || config.authSecret || 'oms-cortex')
    .digest();
}

export function encryptCortexSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptCortexSecret(value: string): string {
  const [ivB64, tagB64, encryptedB64] = value.split('.');
  if (!ivB64 || !tagB64 || !encryptedB64) throw new Error('Invalid encrypted Cortex secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function secretPrefix(secret: string): string {
  return secret.slice(0, 14);
}

async function getUser(userId: string): Promise<AppUserRow | null> {
  const res = await pgQuery<AppUserRow>(
    'SELECT id, email, first_name, last_name, llc_name FROM app_users WHERE id = $1 LIMIT 1',
    [userId],
  );
  return res?.rows[0] || null;
}

export async function getCortexCredential(userId: string): Promise<CortexCredentialRow | null> {
  const res = await pgQuery<CortexCredentialRow>(
    `SELECT * FROM oms_cortex_credentials
     WHERE user_id = $1 AND status = 'active'
     LIMIT 1`,
    [userId],
  );
  return res?.rows[0] || null;
}

export async function ensureCortexCredentialForUser(userId: string): Promise<CortexCredentialRow | null> {
  const existing = await getCortexCredential(userId);
  if (existing?.secret_enc) return existing;
  const user = await getUser(userId);
  if (!user) return null;
  if (!config.cortex.apiKey) {
    await pgQuery(
      `INSERT INTO oms_cortex_credentials (user_id, api_username, status, provisioning_error)
       VALUES ($1, $2, 'pending', 'CORTEX_API_KEY is not configured for bootstrap provisioning')
       ON CONFLICT (user_id) DO UPDATE SET
        status = 'pending',
        provisioning_error = EXCLUDED.provisioning_error,
        updated_at = now()`,
      [userId, `pending_${userId.slice(0, 12)}`],
    );
    return null;
  }
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  const payload = {
    external_user_id: user.id,
    email: user.email,
    account_name: user.llc_name || fullName || user.email,
    company_name: user.llc_name || null,
    relationship_owner_name: fullName || null,
    relationship_owner_email: user.email,
    source_system: 'oms',
    environment: 'production',
    metadata: { provisioned_by: 'unieconnect', user_id: user.id },
  };
  try {
    const res = await fetch(`${config.cortex.apiUrl}/v1/api-credentials/provision/oms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.cortex.apiKey,
      },
      body: JSON.stringify(payload),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body?.client?.api_username) {
      throw new Error(body?.detail || body?.error || `Cortex provisioning failed with ${res.status}`);
    }
    const client = body.client;
    if (!client.secret_key && !existing?.secret_enc) {
      throw new Error('Cortex returned an existing credential without a secret; rotate from Cortex or create a new credential.');
    }
    const secret = client.secret_key || (existing?.secret_enc ? decryptCortexSecret(existing.secret_enc) : '');
    const stored = await pgQuery<CortexCredentialRow>(
      `INSERT INTO oms_cortex_credentials
        (user_id, cortex_credential_id, cortex_tenant_key, api_username, secret_enc, secret_prefix, scopes, model_settings, status, provisioning_error, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active', NULL, now())
       ON CONFLICT (user_id) DO UPDATE SET
        cortex_credential_id = EXCLUDED.cortex_credential_id,
        cortex_tenant_key = EXCLUDED.cortex_tenant_key,
        api_username = EXCLUDED.api_username,
        secret_enc = EXCLUDED.secret_enc,
        secret_prefix = EXCLUDED.secret_prefix,
        scopes = EXCLUDED.scopes,
        model_settings = EXCLUDED.model_settings,
        status = 'active',
        provisioning_error = NULL,
        last_verified_at = now(),
        updated_at = now()
       RETURNING *`,
      [
        userId,
        client.id,
        client.tenant_key,
        client.api_username,
        encryptCortexSecret(secret),
        client.secret_prefix || secretPrefix(secret),
        client.scopes || [],
        JSON.stringify(client.model_settings || {}),
      ],
    );
    // Engagement + tenant-refresh bootstrap (best-effort).
    void ensureCortexEngagementForUser(userId).catch(() => null);
    return stored?.rows[0] || null;
  } catch (error: any) {
    await pgQuery(
      `INSERT INTO oms_cortex_credentials (user_id, api_username, status, provisioning_error)
       VALUES ($1, $2, 'failed', $3)
       ON CONFLICT (user_id) DO UPDATE SET
        status = 'failed',
        provisioning_error = EXCLUDED.provisioning_error,
        updated_at = now()`,
      [userId, existing?.api_username || `failed_${userId.slice(0, 12)}`, String(error?.message || error)],
    );
    return null;
  }
}

export async function getCortexCredentialHeaders(userId?: string | null): Promise<Record<string, string> | null> {
  if (!userId) return null;
  const credential = (await getCortexCredential(userId)) || (await ensureCortexCredentialForUser(userId));
  if (!credential?.secret_enc) return null;
  await pgQuery('UPDATE oms_cortex_credentials SET last_used_at = now(), updated_at = now() WHERE id = $1', [credential.id]).catch(() => null);
  return {
    'X-Cortex-Username': credential.api_username,
    'X-Cortex-Secret-Key': decryptCortexSecret(credential.secret_enc),
    ...(credential.cortex_tenant_key ? { 'X-Cortex-Tenant-Key': credential.cortex_tenant_key } : {}),
  };
}

export async function cortexCredentialStatus(userId: string) {
  const credential = await getCortexCredential(userId);
  if (credential) {
    return {
      provisioned: true,
      status: credential.status,
      apiUsername: credential.api_username,
      secretPrefix: credential.secret_prefix,
      cortexCredentialId: credential.cortex_credential_id,
      cortexTenantKey: credential.cortex_tenant_key,
      scopes: credential.scopes || [],
      modelSettings: credential.model_settings || {},
      lastVerifiedAt: credential.last_verified_at,
      lastUsedAt: credential.last_used_at,
    };
  }
  await ensureCortexCredentialForUser(userId);
  const after = await pgQuery<CortexCredentialRow>('SELECT * FROM oms_cortex_credentials WHERE user_id = $1 LIMIT 1', [userId]);
  const row = after?.rows[0];
  return {
    provisioned: Boolean(row?.status === 'active' && row?.secret_enc),
    status: row?.status || 'missing',
    apiUsername: row?.api_username || null,
    secretPrefix: row?.secret_prefix || null,
    cortexCredentialId: row?.cortex_credential_id || null,
    cortexTenantKey: row?.cortex_tenant_key || null,
    scopes: row?.scopes || [],
    modelSettings: row?.model_settings || {},
    lastVerifiedAt: row?.last_verified_at || null,
    lastUsedAt: row?.last_used_at || null,
    error: row?.provisioning_error || null,
  };
}

const TIER_INTERVAL_MIN: Record<string, number> = { demo: 5, fast: 60, standard: 360, slow: 1440 };

/**
 * Idempotently provision a Cortex engagement for this UnieConnect user and
 * register them in Cortex's tenant_refresh_schedule. Safe to call on every
 * login — short-circuits when the engagement already exists.
 *
 * Best-effort: any HTTP failure leaves the credential row intact and returns
 * null. The user's other flows keep working with degraded intelligence.
 */
export async function ensureCortexEngagementForUser(userId: string): Promise<string | null> {
  const existing = await getCortexCredential(userId);
  if (existing?.cortex_engagement_id) return existing.cortex_engagement_id;

  const user = await getUser(userId);
  if (!user) return null;
  if (!config.cortex.apiKey) return null;

  const credentialName = [user.llc_name, user.first_name, user.last_name, user.email].find(Boolean) || 'OMS user';
  const tier = (existing as any)?.intelligence_tier || 'standard';
  const webhookUrl = `${(process.env.APP_BASE_URL || 'https://api.unieconnect.com').replace(/\/+$/, '')}/api/v1/oms/intelligence/cortex-callback`;
  const webhookSecret = process.env.CORTEX_WEBHOOK_SECRET || '';

  try {
    // 1. Create the Cortex engagement that scopes all future seller-optimization runs.
    const eRes = await fetch(`${config.cortex.apiUrl}/v1/assessment/engagements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.cortex.apiKey },
      body: JSON.stringify({ name: `OMS — ${credentialName}`, external_ref: userId }),
    });
    if (!eRes.ok) {
      console.warn(`[engagement bootstrap] Cortex /engagements POST -> ${eRes.status}`);
      return null;
    }
    const engagement: any = await eRes.json().catch(() => ({}));
    const engagementId = engagement?.engagement_id;
    if (!engagementId) {
      console.warn('[engagement bootstrap] Cortex engagement response missing engagement_id');
      return null;
    }

    // 2. Persist the engagement id + tier defaults on the credential row.
    const intervalMin = TIER_INTERVAL_MIN[tier] || TIER_INTERVAL_MIN.standard;
    await pgQuery(
      `UPDATE oms_cortex_credentials
         SET cortex_engagement_id = $2,
             intelligence_tier = COALESCE(NULLIF(intelligence_tier,''), 'standard'),
             next_intelligence_run_at = COALESCE(next_intelligence_run_at, now() + ($3 || ' minutes')::interval),
             updated_at = now()
       WHERE user_id = $1`,
      [userId, engagementId, String(intervalMin)],
    );

    // 3. Register the tenant on Cortex's scheduler.
    const rRes = await fetch(`${config.cortex.apiUrl}/v1/oms/tenants/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.cortex.apiKey },
      body: JSON.stringify({
        tenant_id: userId,
        engagement_id: engagementId,
        tier,
        webhook_url: webhookUrl,
        webhook_secret: webhookSecret || undefined,
        enabled: true,
      }),
    });
    if (!rRes.ok) {
      console.warn(`[engagement bootstrap] tenant register -> ${rRes.status}`);
    }
    return engagementId;
  } catch (err: any) {
    console.warn('[engagement bootstrap] failed:', err?.message || err);
    return null;
  }
}
