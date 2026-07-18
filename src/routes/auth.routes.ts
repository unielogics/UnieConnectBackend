import { createHash, randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';
import { isValidRole, normalizeRole } from '../lib/roles';
import { ensureCortexCredentialForUser } from '../services/cortex-credentials.service';
import { seedDemoDataForUser, shouldAutoSeed } from '../services/demo-seed.service';
import { syncCurrentUserProfileToWms } from '../services/wms-profile-sync.service';
import { registerWmsCredential } from '../services/oms-wms-credentials.service';
import {
  changeSqlUserPassword,
  findSqlUserById,
  findSqlUserByEmail,
  touchSqlUserLogin,
  updateSqlUserProfile,
  verifySqlUser,
} from '../services/sql-auth';

const DEFAULT_ENABLED_FEATURE_IDS = [
  'core-command-center',
  'core-inventory',
  'core-orders',
  'core-connections',
  'core-marketplace',
  'core-support',
  'app-studio',
];

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

function clearAuthCookie(reply: any, req: any) {
  const host = String(req.headers.host || '');
  const isProdHost = host.endsWith('unieconnect.com');
  const cookieParts = [
    'unie-token=',
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
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

function trim(value: unknown) {
  return String(value ?? '').trim();
}

function safeInviteMetadata(metadata: any) {
  const profile = metadata?.prefillProfile || {};
  if (!metadata || typeof metadata !== 'object') return null;
  return {
    source: metadata.source || null,
    warehouseCode: metadata.warehouseCode || null,
    intermediaryNumber: metadata.intermediaryNumber || null,
    networkPolicy: metadata.networkPolicy || null,
    prefillProfile: {
      email: profile.email || '',
      firstName: profile.firstName || '',
      lastName: profile.lastName || '',
      phone: profile.phone || '',
      companyName: profile.companyName || '',
      llcName: profile.llcName || profile.companyName || '',
      billingAddress: profile.billingAddress || null,
    },
  };
}

function wmsExternalOmsObjectId(userId: string) {
  const normalized = trim(userId);
  if (/^[a-f0-9]{24}$/i.test(normalized)) return normalized.toLowerCase();
  return createHash('sha1').update(`unieconnect:app_user:${normalized}`).digest('hex').slice(0, 24);
}

async function callWmsInternal<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!config.wmsApiUrl || !config.internalApiKey) {
    throw new Error('WMS API or internal key is not configured');
  }
  const res = await fetch(`${config.wmsApiUrl}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Api-Key': config.internalApiKey,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(String(data.message || data.error || `WMS request failed with ${res.status}`));
  }
  return data as T;
}

async function autoConnectWarehouseFromInvite(userId: string, metadata: any, req: any) {
  if (metadata?.source !== 'wms_intermediary_invite') return;
  const connectionCode = trim(metadata.connectionCode).toUpperCase();
  const warehouseCode = trim(metadata.warehouseCode);
  if (!connectionCode || !warehouseCode) return;
  const profile = metadata.prefillProfile || {};
  const billingAddress = profile.billingAddress || {};
  const payload = {
    connectionCode,
    wmsIntermediaryId: metadata.wmsIntermediaryId || undefined,
    networkPolicy: metadata.networkPolicy || {},
    omsIntermediaryId: wmsExternalOmsObjectId(userId),
    omsCompanyName: trim(profile.llcName || profile.companyName || profile.email || `OMS ${userId}`),
    omsFirstName: trim(profile.firstName),
    omsLastName: trim(profile.lastName),
    omsPhone: trim(profile.phone),
    omsEmail: String(profile.email || '').toLowerCase().trim(),
    omsLlcName: trim(profile.llcName || profile.companyName),
    omsBillingAddress: billingAddress,
  };
  const connected = await callWmsInternal<{
    warehouseCode: string;
    wmsIntermediaryId?: string;
    omsIntermediaryId?: string;
  }>('/internal/oms/connect', payload);

  let credentialResult: any = null;
  try {
    credentialResult = await callWmsInternal('/internal/oms/integration-credentials', {
      warehouseCode: connected.warehouseCode || warehouseCode,
      omsIntermediaryId: connected.omsIntermediaryId || payload.omsIntermediaryId,
    });
    const c = credentialResult?.credential;
    if (c?.clientId && c?.passkey) {
      await registerWmsCredential({
        userId,
        warehouseCode: connected.warehouseCode || warehouseCode,
        clientId: c.clientId,
        passkey: c.passkey,
        scopes: c.scopes || [],
        expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
        metadata: {
          source: 'wms_intermediary_invite',
          wmsIntermediaryId: connected.wmsIntermediaryId,
          omsIntermediaryId: connected.omsIntermediaryId,
        },
      });
    }
  } catch (err: any) {
    req.log?.warn({ err, userId, warehouseCode }, 'WMS integration credential registration failed during invite signup');
  }

  await pgQuery(
    `INSERT INTO facilities (user_id, name, type, code, city, state, status, metadata)
     VALUES ($1, $2, 'warehouse', $3, '', '', 'active', $4::jsonb)
     ON CONFLICT DO NOTHING`,
    [
      userId,
      `WMS ${connected.warehouseCode || warehouseCode}`,
      connected.warehouseCode || warehouseCode,
      JSON.stringify({ source: 'wms_intermediary_invite', connectionCode }),
    ],
  ).catch(() => null);

  const facility = await pgQuery<{ id: string }>(
    'SELECT id FROM facilities WHERE user_id = $1 AND code = $2 LIMIT 1',
    [userId, connected.warehouseCode || warehouseCode],
  );
  const facilityId = facility?.rows[0]?.id || null;
  await pgQuery(
    `INSERT INTO oms_warehouse_links (user_id, facility_id, warehouse_code, connection_code, status, metadata)
     VALUES ($1, $2, $3, $4, 'connected', $5::jsonb)
     ON CONFLICT (user_id, warehouse_code)
     DO UPDATE SET status = 'connected', connection_code = EXCLUDED.connection_code, metadata = oms_warehouse_links.metadata || EXCLUDED.metadata`,
    [
      userId,
      facilityId,
      connected.warehouseCode || warehouseCode,
      connectionCode,
      JSON.stringify({
        connectedBy: 'wms_intermediary_invite',
        wmsIntermediaryId: connected.wmsIntermediaryId || metadata.wmsIntermediaryId,
        wmsOmsIntermediaryId: connected.omsIntermediaryId || payload.omsIntermediaryId,
        networkPolicy: metadata.networkPolicy || {},
        credentialId: credentialResult?.credential?.id || null,
      }),
    ],
  );
  await pgQuery('INSERT INTO app_user_activity_log (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)', [
    userId,
    'warehouse_connected_from_invite',
    JSON.stringify({ warehouseCode: connected.warehouseCode || warehouseCode, wmsIntermediaryId: connected.wmsIntermediaryId }),
  ]).catch(() => null);
}

export async function authRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/me', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const user = await findSqlUserById(String(userId));
    if (!user) return reply.code(401).send({ error: 'User not found' });
    return user;
  });

  const updateCurrentUser = async (req: any, reply: any) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const updated = await updateSqlUserProfile(String(userId), req.body || {});
    if (!updated) return reply.code(401).send({ error: 'User not found' });
    void syncCurrentUserProfileToWms(String(userId), req.log).catch((err: any) => {
      req.log?.warn(
        {
          err: String(err?.message || err),
          status: err?.status,
          payload: err?.payload,
          userId: String(userId),
        },
        'WMS profile sync failed after OMS profile update',
      );
    });
    return updated;
  };

  fastify.patch('/auth/me', updateCurrentUser);
  fastify.post('/auth/me', updateCurrentUser);

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

  fastify.post('/auth/logout', async (req: any, reply) => {
    clearAuthCookie(reply, req);
    return { success: true };
  });

  const updateCurrentUserPassword = async (req: any, reply: any) => {
    const userId = req.user?.userId;
    const { oldPassword, newPassword } = req.body || {};
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: 'oldPassword and newPassword required' });
    const result = await changeSqlUserPassword(String(userId), String(oldPassword), String(newPassword));
    if (!result.ok) return reply.code(result.status).send({ error: 'Invalid credentials' });
    return { success: true };
  };

  fastify.post('/auth/change-password', updateCurrentUserPassword);
  fastify.patch('/auth/change-password', updateCurrentUserPassword);

  fastify.get('/auth/invite/validate', async (req: any) => {
    const token = String(req.query?.token || '').trim();
    if (!token) return { valid: false };
    const res = await pgQuery<{ role: string; metadata: any }>(
      'SELECT role, metadata FROM invite_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1',
      [token],
    );
    const invite = res?.rows[0];
    return invite ? { valid: true, role: normalizeRole(invite.role), metadata: safeInviteMetadata(invite.metadata) } : { valid: false };
  });

  fastify.post('/auth/invite/signup', async (req: any, reply) => {
    const { token, firstName, lastName, email, phone, password } = req.body || {};
    const inviteToken = String(token || '').trim();
    if (!inviteToken || !password) {
      return reply.code(400).send({ error: 'token, email and password required' });
    }

    const inviteRes = await pgQuery<{ id: string; role: string; metadata: any }>(
      'SELECT id, role, metadata FROM invite_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1',
      [inviteToken],
    );
    const invite = inviteRes?.rows[0];
    if (!invite) return reply.code(400).send({ error: 'Invalid or expired invite link' });

    const inviteProfile = invite.metadata?.prefillProfile || {};
    const normalizedEmail = String(email || inviteProfile.email || '').toLowerCase().trim();
    if (!normalizedEmail) {
      return reply.code(400).send({ error: 'email is required' });
    }

    const existing = await findSqlUserByEmail(normalizedEmail);
    if (existing) return reply.code(409).send({ error: 'User with this email already exists' });

    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(String(password), 10);
    const role = normalizeRole(invite.role);
    const resolvedFirstName = firstName ? String(firstName).trim() : trim(inviteProfile.firstName);
    const resolvedLastName = lastName ? String(lastName).trim() : trim(inviteProfile.lastName);
    const resolvedPhone = phone ? String(phone).trim() : trim(inviteProfile.phone);
    const resolvedLlcName = trim(inviteProfile.llcName || inviteProfile.companyName);
    const resolvedBillingAddress = inviteProfile.billingAddress || null;
    const _isWhInvite = invite.metadata?.source === 'wms_intermediary_invite';
    const _origin = _isWhInvite ? 'warehouse_invited' : 'direct';
    const _owningWh = _isWhInvite ? (trim(invite.metadata?.warehouseCode) || null) : null;
    await pgQuery(
      `INSERT INTO app_users (id, email, password_hash, role, first_name, last_name, phone, llc_name, billing_address, origin, owning_warehouse_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        userId,
        normalizedEmail,
        passwordHash,
        role,
        resolvedFirstName || null,
        resolvedLastName || null,
        resolvedPhone || null,
        resolvedLlcName || null,
        resolvedBillingAddress ? JSON.stringify(resolvedBillingAddress) : null,
        _origin,
        _owningWh,
      ],
    );
    await pgQuery(
      `INSERT INTO user_features (user_id, feature_id, status, payload)
       SELECT $1, f.id, 'enabled', '{"source":"signup_default"}'::jsonb
       FROM features f
       WHERE f.id = ANY($2::TEXT[])
       ON CONFLICT (user_id, feature_id) DO NOTHING`,
      [userId, DEFAULT_ENABLED_FEATURE_IDS],
    ).catch(() => null);
    await pgQuery('UPDATE app_users SET enabled_features = $2::TEXT[] WHERE id = $1', [userId, DEFAULT_ENABLED_FEATURE_IDS]).catch(() => null);
    await pgQuery('UPDATE invite_tokens SET used_at = now(), used_by = $2 WHERE id = $1', [invite.id, userId]);
    await pgQuery('INSERT INTO app_user_activity_log (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)', [
      userId,
      'invite_signup',
      JSON.stringify({ inviteId: invite.id, source: invite.metadata?.source || 'manual_invite' }),
    ]);

    const user = await findSqlUserById(userId);
    if (!user) return reply.code(500).send({ error: 'User created but could not be loaded' });
    const authToken = signUser(user);
    setAuthCookie(reply, req, authToken);
    // Fire-and-forget: provision Cortex credential + engagement so the AI loop
    // is ready when the user first lands on the BusinessDouble screen.
    void ensureCortexCredentialForUser(userId).catch((err: any) => {
      req.log?.warn({ err, userId }, 'cortex credential auto-provision failed during signup');
    });
    try {
      await autoConnectWarehouseFromInvite(userId, invite.metadata, req);
    } catch (err: any) {
      req.log?.warn({ err, userId, inviteId: invite.id }, 'warehouse auto-connect failed during invite signup');
    }
    // Optional demo data seed for stage/demo accounts.
    if (shouldAutoSeed(normalizedEmail)) {
      void seedDemoDataForUser(userId).catch((err: any) => {
        req.log?.warn({ err, userId }, 'demo auto-seed failed during signup');
      });
    }
    return { token: authToken, user };
  });

  // Public self-signup for direct UnieConnect sellers (no warehouse invite). A direct
  // seller is self-owned (origin='direct', no owning warehouse) and gets AI optimization
  // "at the will of the AI": default features PLUS optimize-suite + product-research, and a
  // Cortex credential provisioned. Warehouse-invited clients still use /auth/invite/signup.
  fastify.post('/auth/signup', async (req: any, reply) => {
    const { firstName, lastName, email, phone, password, companyName } = req.body || {};
    const normalizedEmail = String(email || '').toLowerCase().trim();
    if (!normalizedEmail || !password) {
      return reply.code(400).send({ error: 'email and password are required' });
    }
    if (String(password).length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' });
    }
    const existing = await findSqlUserByEmail(normalizedEmail);
    if (existing) return reply.code(409).send({ error: 'User with this email already exists' });

    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(String(password), 10);
    const role = normalizeRole('ecommerce_client');
    // Direct sellers get the AI suite on by default (optimize-suite + product-research)
    // so the AI can optimize their network nationwide without a warehouse gate.
    const directFeatures = [...DEFAULT_ENABLED_FEATURE_IDS, 'optimize-suite', 'product-research'];
    await pgQuery(
      `INSERT INTO app_users (id, email, password_hash, role, first_name, last_name, phone, llc_name, origin, owning_warehouse_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'direct', NULL)`,
      [
        userId,
        normalizedEmail,
        passwordHash,
        role,
        trim(firstName) || null,
        trim(lastName) || null,
        trim(phone) || null,
        trim(companyName) || null,
      ],
    );
    await pgQuery(
      `INSERT INTO user_features (user_id, feature_id, status, payload)
       SELECT $1, f.id, 'enabled', '{"source":"direct_signup"}'::jsonb
       FROM features f
       WHERE f.id = ANY($2::TEXT[])
       ON CONFLICT (user_id, feature_id) DO NOTHING`,
      [userId, directFeatures],
    ).catch(() => null);
    await pgQuery('UPDATE app_users SET enabled_features = $2::TEXT[] WHERE id = $1', [userId, directFeatures]).catch(() => null);
    await pgQuery('INSERT INTO app_user_activity_log (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)', [
      userId,
      'direct_signup',
      JSON.stringify({ source: 'unieconnect_public_signup' }),
    ]).catch(() => null);

    const user = await findSqlUserById(userId);
    if (!user) return reply.code(500).send({ error: 'User created but could not be loaded' });
    const authToken = signUser(user);
    setAuthCookie(reply, req, authToken);
    // Provision the Cortex credential so AI optimization is ready immediately.
    void ensureCortexCredentialForUser(userId).catch((err: any) => {
      req.log?.warn({ err, userId }, 'cortex credential auto-provision failed during direct signup');
    });
    if (shouldAutoSeed(normalizedEmail)) {
      void seedDemoDataForUser(userId).catch((err: any) => {
        req.log?.warn({ err, userId }, 'demo auto-seed failed during direct signup');
      });
    }
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
    // SECURITY: never return the reset token in the HTTP response — that let any anonymous
    // caller take over any account (submit victim email → receive token → reset password).
    // The token is delivered out-of-band (email). Non-prod may surface it behind an explicit flag.
    if (process.env.EXPOSE_RESET_TOKEN === 'true') {
      return { success: true, resetToken: token };
    }
    return { success: true };
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
