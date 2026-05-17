import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

type CredentialRow = {
  id: string;
  user_id: string | null;
  warehouse_code: string;
  client_id: string;
  passkey_hash: string;
  passkey_enc?: string | null;
  passkey_prefix?: string | null;
  scopes: string[];
  status: string;
  expires_at?: Date | string | null;
};

export function hashPasskey(passkey: string): string {
  return createHash('sha256').update(passkey).digest('hex');
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(config.authSecret || process.env.OMS_CREDENTIAL_ENCRYPTION_KEY || 'oms-wms').digest();
}

export function encryptPasskey(passkey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(passkey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptPasskey(value: string): string {
  const [ivB64, tagB64, encryptedB64] = value.split('.');
  if (!ivB64 || !tagB64 || !encryptedB64) throw new Error('Invalid encrypted passkey');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export async function getWmsCredentialHeaders(params: {
  userId: string;
  warehouseCode: string;
}): Promise<Record<string, string> | null> {
  const res = await pgQuery<CredentialRow>(
    `SELECT * FROM oms_wms_credentials
     WHERE user_id = $1 AND warehouse_code = $2 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [params.userId, params.warehouseCode],
  );
  const credential = res?.rows[0];
  if (!credential?.passkey_enc) return null;
  if (credential.expires_at && new Date(credential.expires_at).getTime() <= Date.now()) return null;
  return {
    'X-WMS-Client-ID': credential.client_id,
    'X-WMS-Passkey': decryptPasskey(credential.passkey_enc),
  };
}

export async function verifyIncomingWmsCredential(clientId: string, passkey: string): Promise<CredentialRow | null> {
  const res = await pgQuery<CredentialRow>(
    `SELECT * FROM oms_wms_credentials WHERE client_id = $1 AND status = 'active' LIMIT 1`,
    [clientId],
  );
  const credential = res?.rows[0];
  if (!credential) return null;
  if (credential.expires_at && new Date(credential.expires_at).getTime() <= Date.now()) return null;
  if (credential.passkey_hash !== hashPasskey(passkey)) return null;
  await pgQuery('UPDATE oms_wms_credentials SET last_used_at = now(), updated_at = now() WHERE id = $1', [credential.id]);
  return credential;
}

export async function registerWmsCredential(input: {
  userId: string;
  warehouseCode: string;
  clientId: string;
  passkey: string;
  scopes?: string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  const passkeyHash = hashPasskey(input.passkey);
  const passkeyEnc = encryptPasskey(input.passkey);
  const passkeyPrefix = input.passkey.slice(0, 10);
  const res = await pgQuery<CredentialRow>(
    `INSERT INTO oms_wms_credentials
      (user_id, warehouse_code, client_id, passkey_hash, passkey_enc, passkey_prefix, scopes, expires_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (client_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      warehouse_code = EXCLUDED.warehouse_code,
      passkey_hash = EXCLUDED.passkey_hash,
      passkey_enc = EXCLUDED.passkey_enc,
      passkey_prefix = EXCLUDED.passkey_prefix,
      scopes = EXCLUDED.scopes,
      expires_at = EXCLUDED.expires_at,
      status = 'active',
      revoked_at = NULL,
      metadata = EXCLUDED.metadata,
      updated_at = now()
     RETURNING *`,
    [
      input.userId,
      input.warehouseCode,
      input.clientId,
      passkeyHash,
      passkeyEnc,
      passkeyPrefix,
      input.scopes || [],
      input.expiresAt || null,
      JSON.stringify(input.metadata || {}),
    ],
  );
  return res?.rows[0] || null;
}

