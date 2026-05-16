import bcrypt from 'bcryptjs';
import { pgQuery, isPostgresConfigured } from '../db/postgres';
import { normalizeRole } from '../lib/roles';

type SqlUserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  llc_name: string | null;
  billing_address: any;
  enabled_features: string[] | null;
  last_login_at: Date | string | null;
};

export type AppUserProfile = {
  userId: string;
  email: string;
  role: ReturnType<typeof normalizeRole>;
  firstName?: string;
  lastName?: string;
  phone?: string;
  llcName?: string;
  billingAddress?: any;
  enabledFeatures?: string[];
  lastLoginAt?: Date | string | null;
};

const toProfile = (row: SqlUserRow): AppUserProfile => {
  const profile: AppUserProfile = {
    userId: row.id,
    email: row.email,
    role: normalizeRole(row.role),
    enabledFeatures: row.enabled_features || [],
    lastLoginAt: row.last_login_at,
  };
  if (row.first_name) profile.firstName = row.first_name;
  if (row.last_name) profile.lastName = row.last_name;
  if (row.phone) profile.phone = row.phone;
  if (row.llc_name) profile.llcName = row.llc_name;
  if (row.billing_address) profile.billingAddress = row.billing_address;
  return profile;
};

export function isSqlAuthEnabled() {
  return isPostgresConfigured();
}

export async function findSqlUserById(userId: string): Promise<AppUserProfile | null> {
  if (!isSqlAuthEnabled()) return null;
  const res = await pgQuery<SqlUserRow>(
    `SELECT id, email, password_hash, role, first_name, last_name, phone, llc_name, billing_address, enabled_features, last_login_at
     FROM app_users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = res?.rows[0];
  return row ? toProfile(row) : null;
}

export async function findSqlUserByEmail(email: string): Promise<(AppUserProfile & { passwordHash: string }) | null> {
  if (!isSqlAuthEnabled()) return null;
  const normalizedEmail = email.toLowerCase().trim();
  const res = await pgQuery<SqlUserRow>(
    `SELECT id, email, password_hash, role, first_name, last_name, phone, llc_name, billing_address, enabled_features, last_login_at
     FROM app_users WHERE email = $1 LIMIT 1`,
    [normalizedEmail],
  );
  const row = res?.rows[0];
  return row ? { ...toProfile(row), passwordHash: row.password_hash } : null;
}

export async function verifySqlUser(email: string, password: string): Promise<AppUserProfile | null> {
  const user = await findSqlUserByEmail(email);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

export async function touchSqlUserLogin(userId: string) {
  await pgQuery('UPDATE app_users SET last_login_at = now(), updated_at = now() WHERE id = $1', [userId]);
  await pgQuery('INSERT INTO app_user_activity_log (user_id, action) VALUES ($1, $2)', [userId, 'login']);
}

export async function updateSqlUserProfile(userId: string, body: any): Promise<AppUserProfile | null> {
  const current = await findSqlUserById(userId);
  if (!current) return null;
  const next = {
    firstName: body.firstName !== undefined ? (body.firstName ? String(body.firstName).trim() : null) : current.firstName || null,
    lastName: body.lastName !== undefined ? (body.lastName ? String(body.lastName).trim() : null) : current.lastName || null,
    phone: body.phone !== undefined ? (body.phone ? String(body.phone).trim() : null) : current.phone || null,
    llcName: body.llcName !== undefined ? (body.llcName ? String(body.llcName).trim() : null) : current.llcName || null,
    billingAddress: body.billingAddress !== undefined ? body.billingAddress || null : current.billingAddress || null,
  };
  const res = await pgQuery<SqlUserRow>(
    `UPDATE app_users
     SET first_name = $2, last_name = $3, phone = $4, llc_name = $5, billing_address = $6::jsonb, updated_at = now()
     WHERE id = $1
     RETURNING id, email, password_hash, role, first_name, last_name, phone, llc_name, billing_address, enabled_features, last_login_at`,
    [
      userId,
      next.firstName,
      next.lastName,
      next.phone,
      next.llcName,
      next.billingAddress ? JSON.stringify(next.billingAddress) : null,
    ],
  );
  const row = res?.rows[0];
  return row ? toProfile(row) : null;
}

export async function changeSqlUserPassword(userId: string, oldPassword: string, newPassword: string) {
  const res = await pgQuery<SqlUserRow>('SELECT password_hash FROM app_users WHERE id = $1 LIMIT 1', [userId]);
  const row = res?.rows[0];
  if (!row) return { ok: false, status: 401 as const };
  const valid = await bcrypt.compare(oldPassword, row.password_hash);
  if (!valid) return { ok: false, status: 401 as const };
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pgQuery('UPDATE app_users SET password_hash = $2, reset_token = NULL, reset_token_expires = NULL, updated_at = now() WHERE id = $1', [userId, passwordHash]);
  await pgQuery('INSERT INTO app_user_activity_log (user_id, action) VALUES ($1, $2)', [userId, 'password_change']);
  return { ok: true, status: 200 as const };
}
