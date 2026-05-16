import { normalizeRole } from '../lib/roles';

export function isMongoReady() {
  return false;
}

export function isMongoDisabled() {
  return true;
}

export function isDegradedAuthEnabled() {
  return false;
}

export function getDegradedUser() {
  return null;
}

export async function tryDegradedLogin(_email: string, _password: string) {
  return null;
}

export function getSqlOnlyRuntimeStatus() {
  return {
    mongo: 'purged',
    replacement: 'aurora_postgres',
    defaultRole: normalizeRole(process.env.OMS_DEGRADED_USER_ROLE || 'ecommerce_client'),
  };
}
