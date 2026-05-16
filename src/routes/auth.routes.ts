import { randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';
import { isValidRole, normalizeRole } from '../lib/roles';
import {
  changeSqlUserPassword,
  findSqlUserById,
  findSqlUserByEmail,
  touchSqlUserLogin,
  updateSqlUserProfile,
  verifySqlUser,
} from '../services/sql-auth';

function setAuthCookie(reply: any, req: any, token: string, maxAgeSeconds = 7 * 24 * 60 * 60) {
  const host = String(req.headers.host || '');
  const isProdHost = host.endsWith('unieconnect.com');
  const cookieParts = [
    `unie-token=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSeconds}`,
    isProdHost ? 'Secure' : '',
    isProdHost ? 'SameSite=None' : 'SameSite=Lax',
    isProdHost ? 'Domain=.unieconnect.com' : '',
  ].filter(Boolean);
  reply.header('Set-Cookie', cookieParts.join('; '));
}

function signUser(user: { userId: string; email: string; role: string }) {
  return jwt.sign(
    { userId: user.userId, email: user.email, role: normalizeRole(user.role), authSource: 'aurora_postgres' },
    config.authSecret,
    { expiresIn: '7d' },
  );
}

export async function authRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/me', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const user = await findSqlUserById(String(userId));
    if (!user) return reply.code(401).send({ error: 'User not found' });
    return user;
  });

  fastify.patch('/auth/me', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const updated = await updateSqlUserProfile(String(userId), req.body || {});
    if (!updated) return reply.code(401).send({ error: 'User not found' });
    return updated;
  });

  fastify.post('/auth/login', async (req: any, reply) => {
    const { email, password } = req.body || {};
    const normalizedEmail = email ? String(email).toLowerCase().trim() : '';
    req.log.info({ reqId: req.id, email: normalizedEmail, ip: req.ip }, 'login attempt');
    if (!normalizedEmail || !password) return reply.code(400).send({ error: 'Email and password required' });

    const user = await verifySqlUser(normalizedEmail, String(password));
    if (!user) {
      req.log.warn({ reqId: req.id, email: normalizedEmail }, 'login failed');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    await touchSqlUserLogin(user.userId);
    const token = signUser(user);
    setAuthCookie(reply, req, token);
    req.log.info({ reqId: req.id, userId: user.userId, email: user.email }, 'sql login success');
    return { token, user };
  });

  fastify.post('/auth/change-password', async (req: any, reply) => {
    const userId = req.user?.userId;
    const { oldPassword, newPassword } = req.body || {};
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: 'oldPassword and newPassword required' });
    const result = await changeSqlUserPassword(String(userId), String(oldPassword), String(newPassword));
    if (!result.ok) return reply.code(result.status).send({ error: 'Invalid credentials' });
    return { success: true };
  });

  fastify.get('/auth/invite/validate', async (req: any) => {
    const token = String(req.query?.token || '').trim();
    if (!token) return { valid: false };
    const res = await pgQuery<{ role: string }>(
      'SELECT role FROM invite_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1',
      [token],
    );
    const invite = res?.rows[0];
    return invite ? { valid: true, role: normalizeRole(invite.role) } : { valid: false };
  });

  fastify.post('/auth/invite/signup', async (req: any, reply) => {
    const { token, firstName, lastName, email, phone, password } = req.body || {};
    const inviteToken = String(token || '').trim();
    const normalizedEmail = String(email || '').toLowerCase().trim();
    if (!inviteToken || !normalizedEmail || !password) {
      return reply.code(400).send({ error: 'token, email and password required' });
    }

    const inviteRes = await pgQuery<{ id: string; role: string }>(
      'SELECT id, role FROM invite_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1',
      [inviteToken],
    );
    const invite = inviteRes?.rows[0];
    if (!invite) return reply.code(400).send({ error: 'Invalid or expired invite link' });

    const existing = await findSqlUserByEmail(normalizedEmail);
    if (existing) return reply.code(409).send({ error: 'User with this email already exists' });

    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(String(password), 10);
    const role = normalizeRole(invite.role);
    await pgQuery(
      `INSERT INTO app_users (id, email, password_hash, role, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        normalizedEmail,
        passwordHash,
        role,
        firstName ? String(firstName).trim() : null,
        lastName ? String(lastName).trim() : null,
        phone ? String(phone).trim() : null,
      ],
    );
    await pgQuery('UPDATE invite_tokens SET used_at = now(), used_by = $2 WHERE id = $1', [invite.id, userId]);
    await pgQuery('INSERT INTO app_user_activity_log (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)', [
      userId,
      'invite_signup',
      JSON.stringify({ inviteId: invite.id }),
    ]);

    const user = await findSqlUserById(userId);
    if (!user) return reply.code(500).send({ error: 'User created but could not be loaded' });
    const authToken = signUser(user);
    setAuthCookie(reply, req, authToken);
    return { token: authToken, user };
  });

  fastify.post('/auth/request-reset', async (req: any) => {
    const normalizedEmail = String(req.body?.email || '').toLowerCase().trim();
    if (!normalizedEmail) return { success: true };
    const user = await findSqlUserByEmail(normalizedEmail);
    if (!user) return { success: true };
    const token = randomBytes(24).toString('hex');
    await pgQuery(
      'UPDATE app_users SET reset_token = $2, reset_token_expires = now() + interval \'1 hour\', updated_at = now() WHERE id = $1',
      [user.userId, token],
    );
    return { success: true, resetToken: token };
  });

  fastify.post('/auth/reset-password', async (req: any, reply) => {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!token || !newPassword) return reply.code(400).send({ error: 'token and newPassword required' });
    const res = await pgQuery<{ id: string }>(
      'SELECT id FROM app_users WHERE reset_token = $1 AND reset_token_expires > now() LIMIT 1',
      [token],
    );
    const user = res?.rows[0];
    if (!user) return reply.code(400).send({ error: 'Invalid or expired token' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pgQuery(
      'UPDATE app_users SET password_hash = $2, reset_token = NULL, reset_token_expires = NULL, updated_at = now() WHERE id = $1',
      [user.id, passwordHash],
    );
    await pgQuery('INSERT INTO app_user_activity_log (user_id, action) VALUES ($1, $2)', [user.id, 'password_reset']);
    return { success: true };
  });
}
