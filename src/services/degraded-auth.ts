import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { normalizeRole } from '../lib/roles';

const fallbackUserId = () => process.env.OMS_DEGRADED_USER_ID || '000000000000000000000001';
const fallbackEmail = () => (process.env.OMS_DEGRADED_USER_EMAIL || '').trim().toLowerCase();
const fallbackRole = () => normalizeRole(process.env.OMS_DEGRADED_USER_ROLE || 'admin');

export function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

export function isDegradedAuthEnabled() {
  return (
    process.env.OMS_ALLOW_DEGRADED_START === 'true' &&
    !isMongoReady() &&
    Boolean(fallbackEmail()) &&
    Boolean(process.env.OMS_DEGRADED_USER_PASSWORD_HASH || process.env.OMS_DEGRADED_USER_PASSWORD)
  );
}

export function getDegradedUser() {
  const email = fallbackEmail();
  if (!email) return null;
  return {
    userId: fallbackUserId(),
    email,
    role: fallbackRole(),
    firstName: process.env.OMS_DEGRADED_USER_FIRST_NAME || 'OMS',
    lastName: process.env.OMS_DEGRADED_USER_LAST_NAME || 'Recovery',
    phone: undefined,
    llcName: 'UnieConnect',
    billingAddress: undefined,
    lastLoginAt: undefined,
  };
}

export async function tryDegradedLogin(email: string, password: string) {
  if (!isDegradedAuthEnabled()) return null;
  const expectedEmail = fallbackEmail();
  if (!expectedEmail || email.toLowerCase().trim() !== expectedEmail) return null;

  const passwordHash = process.env.OMS_DEGRADED_USER_PASSWORD_HASH;
  const plainPassword = process.env.OMS_DEGRADED_USER_PASSWORD;
  const ok = passwordHash
    ? await bcrypt.compare(password, passwordHash)
    : Boolean(plainPassword && password === plainPassword);
  if (!ok) return null;
  return getDegradedUser();
}
