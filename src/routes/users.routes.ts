import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { User } from '../models/user';
import { InviteToken } from '../models/invite-token';
import { UserActivityLog } from '../models/user-activity-log';
import { requireRole, CAN_MANAGE_USERS, isValidRole } from '../lib/roles';
import { config } from '../config/env';

export async function usersRoutes(fastify: FastifyInstance) {
  const requireManageUsers = requireRole(CAN_MANAGE_USERS);

  fastify.get('/users', {
    preHandler: [requireManageUsers],
  }, async (req: any, reply) => {
    const users = await User.find({})
      .select('email role firstName lastName phone lastLoginAt createdAt')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return {
      users: users.map((u) => ({
        id: u._id,
        email: u.email,
        role: u.role,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      })),
    };
  });

  fastify.post('/users', {
    preHandler: [requireManageUsers],
  }, async (req: any, reply) => {
    const { email, password, role: requestedRole, firstName, lastName, phone } = (req.body || {}) as {
      email?: string;
      password?: string;
      role?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    };

    const normalizedEmail = email ? String(email).toLowerCase().trim() : '';
    if (!normalizedEmail || !password) {
      return reply.code(400).send({ error: 'email and password required' });
    }

    const role = isValidRole(requestedRole) ? requestedRole : 'ecommerce_client';

    if (normalizedEmail === config.superAdminEmail) {
      const callerRole = req.user?.role;
      if (callerRole !== 'super_admin') {
        return reply.code(403).send({ error: 'Only super_admin can create the super admin account' });
      }
    }

    const existing = await User.findOne({ email: normalizedEmail }).exec();
    if (existing) {
      return reply.code(409).send({ error: 'User with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await User.create({
      email: normalizedEmail,
      passwordHash,
      role,
      firstName: firstName ? String(firstName).trim() : undefined,
      lastName: lastName ? String(lastName).trim() : undefined,
      phone: phone ? String(phone).trim() : undefined,
    });

    await UserActivityLog.create({ userId: user._id, action: 'user_created' });
    req.log.info({ reqId: req.id, createdBy: req.user?.userId, newUserId: user._id, email: user.email, role }, 'user created');

    return {
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
    };
  });

  fastify.post('/users/invites', {
    preHandler: [requireManageUsers],
  }, async (req: any, reply) => {
    const { role: requestedRole } = (req.body || {}) as { role?: string };
    const role = isValidRole(requestedRole) ? requestedRole : 'ecommerce_client';
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await InviteToken.create({
      token,
      role,
      expiresAt,
      createdBy: req.user.userId,
    });
    const base = (config.frontendOrigin || '').replace(/\/+$/, '');
    const inviteLink = base ? `${base}/signup?token=${token}` : `/signup?token=${token}`;
    return { inviteLink };
  });

  fastify.get('/users/:userId/activity', {
    preHandler: [requireManageUsers],
  }, async (req: any, reply) => {
    const { userId } = req.params as { userId: string };
    const limit = Math.min(Math.max(0, Number((req.query as { limit?: string }).limit) || 50), 100);
    const skip = Math.max(0, Number((req.query as { offset?: string }).offset) || 0);
    const events = await UserActivityLog.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
    return {
      events: events.map((e) => ({
        action: e.action,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
    };
  });
}
