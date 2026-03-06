import { FastifyRequest, FastifyReply } from 'fastify';

/** Allowed role values */
export const ALL_ROLES = ['super_admin', 'management', 'ecommerce_client', 'billing'] as const;

export type UserRole = (typeof ALL_ROLES)[number];

/** Roles that can manage users (list, create) */
export const CAN_MANAGE_USERS: UserRole[] = ['super_admin', 'management'];

export function isValidRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ALL_ROLES as readonly string[]).includes(value);
}

/** Map legacy 'admin' to 'management' for backward compatibility */
export function normalizeRole(role: string | undefined): UserRole {
  if (role === 'admin') return 'management';
  return isValidRole(role) ? role : 'ecommerce_client';
}

/**
 * Middleware factory: require user to have one of the allowed roles.
 * Must run after JWT auth preHandler. Uses req.user.role from token if present,
 * otherwise loads user from DB to get role (handles tokens issued before role was added).
 */
export function requireRole(allowedRoles: readonly UserRole[]) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    let role: string | undefined = (req as any).user?.role;
    if (!role) {
      const { User } = await import('../models/user');
      const user = await User.findById(userId).select('role').lean().exec();
      if (!user) return reply.code(401).send({ error: 'User not found' });
      role = user.role;
    }
    const normalizedRole = normalizeRole(role);

    if (!allowedRoles.includes(normalizedRole)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    }
  };
}
