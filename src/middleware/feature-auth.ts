import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { User } from '../models/user';
import { Feature } from '../models/feature';
import { UserFeature } from '../models/user-feature';

/**
 * Middleware to check if user has access to a feature
 * Usage: app.register(requireFeature('feature-slug'))
 */
export function requireFeature(featureSlug: string) {
  return async function (fastify: FastifyInstance) {
    fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = (req as any).user?.userId;
      if (!userId) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      // Find feature by slug
      const feature = await Feature.findOne({ slug: featureSlug, isActive: true }).exec();
      if (!feature) {
        return reply.code(404).send({ error: 'Feature not found' });
      }

      // Standard features are always available
      if (feature.isStandard) {
        return; // Allow access
      }

      // Check if user has feature enabled
      const user = await User.findById(userId).exec();
      if (!user) {
        return reply.code(401).send({ error: 'User not found' });
      }

      // Check cache first
      if (user.enabledFeatures && user.enabledFeatures.includes(featureSlug)) {
        // Verify it's still active
        const userFeature = await UserFeature.findOne({
          userId,
          featureId: feature._id,
          status: 'active',
        }).exec();

        if (userFeature) {
          return; // Allow access
        }
      }

      // Feature not enabled
      return reply.code(403).send({
        error: 'Feature not enabled',
        feature: {
          slug: feature.slug,
          name: feature.name,
          pricing: feature.pricing,
        },
        message: `This feature requires activation. Please enable "${feature.name}" in the marketplace.`,
      });
    });
  };
}

/**
 * Helper function to check if user has feature enabled (for use in route handlers)
 */
export async function hasFeature(userId: string, featureSlug: string): Promise<boolean> {
  const feature = await Feature.findOne({ slug: featureSlug, isActive: true }).exec();
  if (!feature) return false;
  if (feature.isStandard) return true;

  const user = await User.findById(userId).exec();
  if (!user) return false;

  if (user.enabledFeatures && user.enabledFeatures.includes(featureSlug)) {
    const userFeature = await UserFeature.findOne({
      userId,
      featureId: feature._id,
      status: 'active',
    }).exec();
    return !!userFeature;
  }

  return false;
}
