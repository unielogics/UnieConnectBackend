import { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { User } from '../models/user';
import { InviteToken } from '../models/invite-token';
import { UserActivityLog } from '../models/user-activity-log';
import { config } from '../config/env';
import { normalizeRole } from '../lib/roles';
import crypto from 'crypto';

export async function authRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/me', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const user = await User.findById(userId).select('email role firstName lastName phone lastLoginAt').lean().exec();
    if (!user) return reply.code(401).send({ error: 'User not found' });
    return {
      userId: user._id,
      email: user.email,
      role: normalizeRole(user.role),
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      lastLoginAt: user.lastLoginAt,
    };
  });

  fastify.post('/auth/login', async (req: any, reply) => {
    const { email, password } = req.body || {};
    const normalizedEmail = email ? String(email).toLowerCase() : '';
    req.log.info({ reqId: req.id, email: normalizedEmail, ip: req.ip }, 'login attempt');
    if (!email || !password) return reply.code(400).send({ error: 'Email and password required' });
    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user) {
      req.log.warn({ reqId: req.id, email: normalizedEmail }, 'login failed: user not found');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      req.log.warn({ reqId: req.id, email: normalizedEmail, userId: user._id }, 'login failed: bad password');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    user.lastLoginAt = new Date();
    await user.save();
    await UserActivityLog.create({ userId: user._id, action: 'login' });
    const role = normalizeRole(user.role);
    const token = jwt.sign(
      { userId: user._id, email: user.email, role },
      config.authSecret,
      { expiresIn: '7d' }
    );
    const host = String(req.headers.host || '');
    const isProdHost = host.endsWith('unieconnect.com');
    const cookieParts = [
      `unie-token=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      `Max-Age=${7 * 24 * 60 * 60}`,
      isProdHost ? 'Secure' : '',
      isProdHost ? 'SameSite=None' : 'SameSite=Lax',
      isProdHost ? 'Domain=.unieconnect.com' : '',
    ].filter(Boolean);
    reply.header('Set-Cookie', cookieParts.join('; '));
    req.log.info({ reqId: req.id, userId: user._id, email: user.email }, 'login success');
    return { token, user: { userId: user._id, email: user.email, role } };
  });

  fastify.post('/auth/change-password', async (req: any, reply) => {
    const userId = req.user?.userId;
    req.log.info({ reqId: req.id, userId }, 'change password attempt');
    const { oldPassword, newPassword } = req.body || {};
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: 'oldPassword and newPassword required' });
    const user = await User.findById(userId).exec();
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    const ok = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: 'Invalid credentials' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetToken = null as any;
    user.resetTokenExpires = null as any;
    await user.save();
    await UserActivityLog.create({ userId, action: 'password_change' });
    req.log.info({ reqId: req.id, userId }, 'password updated');
    return { success: true };
  });

  fastify.get('/auth/invite/validate', async (req: any, reply) => {
    const token = (req.query as { token?: string }).token;
    if (!token) return reply.send({ valid: false });
    const invite = await InviteToken.findOne({ token }).lean().exec();
    if (!invite || invite.usedAt || (invite.expiresAt && invite.expiresAt.getTime() < Date.now())) {
      return reply.send({ valid: false });
    }
    return reply.send({ valid: true, role: invite.role });
  });

  fastify.post('/auth/invite/signup', async (req: any, reply) => {
    const { token: inviteTokenValue, firstName, lastName, email, phone, password } = (req.body || {}) as {
      token?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      password?: string;
    };
    if (!inviteTokenValue || !email || !password) {
      return reply.code(400).send({ error: 'token, email and password required' });
    }
    const invite = await InviteToken.findOne({ token: inviteTokenValue }).exec();
    if (!invite || invite.usedAt || (invite.expiresAt && invite.expiresAt.getTime() < Date.now())) {
      return reply.code(400).send({ error: 'Invalid or expired invite link' });
    }
    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail }).exec();
    if (existing) return reply.code(409).send({ error: 'User with this email already exists' });
    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await User.create({
      email: normalizedEmail,
      passwordHash,
      role: invite.role,
      firstName: firstName ? String(firstName).trim() : undefined,
      lastName: lastName ? String(lastName).trim() : undefined,
      phone: phone ? String(phone).trim() : undefined,
    });
    invite.usedAt = new Date();
    await invite.save();
    await UserActivityLog.create({
      userId: user._id,
      action: 'invite_signup',
      metadata: { inviteTokenId: invite._id },
    });
    const role = normalizeRole(user.role);
    const token = jwt.sign(
      { userId: user._id, email: user.email, role },
      config.authSecret,
      { expiresIn: '7d' }
    );
    req.log.info({ reqId: req.id, userId: user._id, email: user.email }, 'invite signup success');
    return {
      token,
      user: { userId: user._id, email: user.email, role },
    };
  });

  fastify.post('/auth/request-reset', async (req: any, reply) => {
    const { email } = req.body || {};
    const normalizedEmail = email ? String(email).toLowerCase() : '';
    req.log.info({ reqId: req.id, email: normalizedEmail }, 'password reset requested');
    if (!email) return reply.code(400).send({ error: 'Email required' });
    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user) return reply.send({ success: true }); // avoid leakage
    const token = crypto.randomBytes(24).toString('hex');
    user.resetToken = token as any;
    user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    req.log.info({ reqId: req.id, userId: user._id, email: user.email }, 'password reset token issued');
    // Since email not set up, return token in response for now
    return { success: true, resetToken: token };
  });

  fastify.post('/auth/reset-password', async (req: any, reply) => {
    const { token, newPassword } = req.body || {};
    req.log.info({ reqId: req.id, hasToken: Boolean(token) }, 'reset password attempt');
    if (!token || !newPassword) return reply.code(400).send({ error: 'token and newPassword required' });
    const user = await User.findOne({ resetToken: token }).exec();
    if (!user || !user.resetTokenExpires || user.resetTokenExpires.getTime() < Date.now()) {
      req.log.warn({ reqId: req.id }, 'reset password failed: invalid/expired token');
      return reply.code(400).send({ error: 'Invalid or expired token' });
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetToken = null as any;
    user.resetTokenExpires = null as any;
    await user.save();
    req.log.info({ reqId: req.id, userId: user._id }, 'password reset success');
    return { success: true };
  });
}

