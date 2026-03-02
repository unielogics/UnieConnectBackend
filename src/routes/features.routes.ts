import { FastifyInstance } from 'fastify';
import { Feature } from '../models/feature';
import { UserFeature } from '../models/user-feature';
import { User } from '../models/user';

export async function featureRoutes(fastify: FastifyInstance) {
  // List all features with search and filters
  fastify.get('/features', async (req: any, reply) => {
    const userId = req.user?.userId;
    const { search, category, isStandard, isActive, pricingType, page = 1, limit = 50 } = req.query || {};

    const query: any = {};
    if (search) {
      query.$text = { $search: String(search) };
    }
    if (category) {
      query.category = String(category);
    }
    if (isStandard !== undefined) {
      query.isStandard = String(isStandard) === 'true';
    }
    if (isActive !== undefined) {
      query.isActive = String(isActive) === 'true';
    } else {
      query.isActive = true; // Default to active features only
    }
    if (pricingType) {
      query['pricing.type'] = String(pricingType);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const features = await Feature.find(query)
      .sort(search ? { score: { $meta: 'textScore' } } : { isStandard: -1, name: 1 })
      .skip(skip)
      .limit(Number(limit))
      .lean()
      .exec();

    // Get user's enabled features if authenticated
    let enabledFeatureIds: string[] = [];
    if (userId) {
      const userFeatures = await UserFeature.find({ userId, status: 'active' })
        .select('featureId')
        .lean()
        .exec();
      enabledFeatureIds = userFeatures.map((uf) => String(uf.featureId));
    }

    // Enrich features with enabled status
    const enriched = features.map((f: any) => ({
      ...f,
      isEnabled: enabledFeatureIds.includes(String(f._id)),
      id: String(f._id),
    }));

    const total = await Feature.countDocuments(query).exec();

    return {
      features: enriched,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    };
  });

  // Get marketplace-specific features (non-standard)
  fastify.get('/features/marketplace', async (req: any, reply) => {
    const userId = req.user?.userId;
    const { search, category, pricingType, page = 1, limit = 50 } = req.query || {};

    const query: any = { isStandard: false, isActive: true };
    if (search) {
      query.$text = { $search: String(search) };
    }
    if (category) {
      query.category = String(category);
    }
    if (pricingType) {
      query['pricing.type'] = String(pricingType);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const features = await Feature.find(query)
      .sort(search ? { score: { $meta: 'textScore' } } : { name: 1 })
      .skip(skip)
      .limit(Number(limit))
      .lean()
      .exec();

    let enabledFeatureIds: string[] = [];
    if (userId) {
      const userFeatures = await UserFeature.find({ userId, status: 'active' })
        .select('featureId')
        .lean()
        .exec();
      enabledFeatureIds = userFeatures.map((uf) => String(uf.featureId));
    }

    const enriched = features.map((f: any) => ({
      ...f,
      isEnabled: enabledFeatureIds.includes(String(f._id)),
      id: String(f._id),
    }));

    const total = await Feature.countDocuments(query).exec();

    // Get categories for filtering
    const categories = await Feature.distinct('category', { isStandard: false, isActive: true }).exec();

    return {
      features: enriched,
      categories,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    };
  });

  // Get feature by ID or slug
  fastify.get('/features/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    const { id } = req.params || {};

    const query: any = {};
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      query._id = id;
    } else {
      query.slug = String(id).toLowerCase();
    }

    const feature = await Feature.findOne(query).lean().exec();
    if (!feature) return reply.code(404).send({ error: 'Feature not found' });

    let isEnabled = false;
    if (userId) {
      const userFeature = await UserFeature.findOne({
        userId,
        featureId: feature._id,
        status: 'active',
      })
        .lean()
        .exec();
      isEnabled = !!userFeature;
    }

    return {
      ...feature,
      id: String(feature._id),
      isEnabled,
    };
  });

  // Get user's enabled features
  fastify.get('/user/features', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const userFeatures = await UserFeature.find({ userId, status: 'active' })
      .populate('featureId')
      .lean()
      .exec();

    const features = userFeatures.map((uf: any) => ({
      ...uf.featureId,
      id: String(uf.featureId._id),
      enabledAt: uf.enabledAt,
      status: uf.status,
    }));

    // Also include standard features
    const standardFeatures = await Feature.find({ isStandard: true, isActive: true })
      .lean()
      .exec();

    const allFeatures = [
      ...standardFeatures.map((f: any) => ({
        ...f,
        id: String(f._id),
        isStandard: true,
        isEnabled: true,
      })),
      ...features,
    ];

    return { features: allFeatures };
  });

  // Enable a feature for user
  fastify.post('/features/:id/enable', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params || {};
    const query: any = {};
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      query._id = id;
    } else {
      query.slug = String(id).toLowerCase();
    }

    const feature = await Feature.findOne(query).exec();
    if (!feature) return reply.code(404).send({ error: 'Feature not found' });
    if (!feature.isActive) return reply.code(400).send({ error: 'Feature is not active' });

    // Check if already enabled
    const existing = await UserFeature.findOne({ userId, featureId: feature._id }).exec();
    if (existing && existing.status === 'active') {
      return { success: true, message: 'Feature already enabled', feature: feature.toObject() };
    }

    // Check dependencies
    if (feature.requiredFeatures && feature.requiredFeatures.length > 0) {
      const user = await User.findById(userId).exec();
      if (!user) return reply.code(401).send({ error: 'User not found' });

      const enabledSlugs = user.enabledFeatures || [];
      const missing = feature.requiredFeatures.filter((reqSlug) => !enabledSlugs.includes(reqSlug));
      if (missing.length > 0) {
        return reply.code(400).send({
          error: 'Missing required features',
          requiredFeatures: missing,
        });
      }
    }

    // Determine status based on pricing
    let status: 'active' | 'trial' = 'active';
    let expiresAt: Date | undefined;
    if (feature.pricing.trialDays && feature.pricing.trialDays > 0) {
      status = 'trial';
      expiresAt = new Date(Date.now() + feature.pricing.trialDays * 24 * 60 * 60 * 1000);
    }

    if (existing) {
      existing.status = status;
      existing.enabledAt = new Date();
      if (expiresAt) existing.expiresAt = expiresAt;
      await existing.save();
    } else {
      await UserFeature.create({
        userId,
        featureId: feature._id,
        status,
        enabledAt: new Date(),
        expiresAt,
      });
    }

    // Update user's enabledFeatures cache
    await User.findByIdAndUpdate(userId, {
      $addToSet: { enabledFeatures: feature.slug },
    }).exec();

    req.log.info({ userId, featureId: feature._id, featureSlug: feature.slug }, 'feature enabled');

    return {
      success: true,
      message: 'Feature enabled',
      feature: feature.toObject(),
      status,
      expiresAt,
    };
  });

  // Disable a feature for user
  fastify.post('/features/:id/disable', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params || {};
    const query: any = {};
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      query._id = id;
    } else {
      query.slug = String(id).toLowerCase();
    }

    const feature = await Feature.findOne(query).exec();
    if (!feature) return reply.code(404).send({ error: 'Feature not found' });

    // Don't allow disabling standard features
    if (feature.isStandard) {
      return reply.code(400).send({ error: 'Cannot disable standard feature' });
    }

    const userFeature = await UserFeature.findOne({ userId, featureId: feature._id }).exec();
    if (!userFeature || userFeature.status === 'disabled') {
      return { success: true, message: 'Feature already disabled' };
    }

    userFeature.status = 'disabled';
    await userFeature.save();

    // Update user's enabledFeatures cache
    await User.findByIdAndUpdate(userId, {
      $pull: { enabledFeatures: feature.slug },
    }).exec();

    req.log.info({ userId, featureId: feature._id, featureSlug: feature.slug }, 'feature disabled');

    return {
      success: true,
      message: 'Feature disabled',
      feature: feature.toObject(),
    };
  });

  // Purchase/activate paid feature (placeholder for payment integration)
  fastify.post('/features/:id/purchase', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params || {};
    const { paymentMethodId, subscriptionId } = req.body || {};

    const query: any = {};
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      query._id = id;
    } else {
      query.slug = String(id).toLowerCase();
    }

    const feature = await Feature.findOne(query).exec();
    if (!feature) return reply.code(404).send({ error: 'Feature not found' });

    if (feature.pricing.type === 'free') {
      // For free features, just enable them
      return fastify.inject({
        method: 'POST',
        url: `/api/v1/features/${id}/enable`,
        headers: { authorization: req.headers.authorization },
      });
    }

    // TODO: Integrate with payment provider (Stripe, etc.)
    // For now, just enable the feature
    req.log.warn({ userId, featureId: feature._id }, 'purchase endpoint called - payment not implemented');

    const result = await fastify.inject({
      method: 'POST',
      url: `/api/v1/features/${id}/enable`,
      headers: { authorization: req.headers.authorization },
    });

    return {
      success: true,
      message: 'Feature purchased and enabled (payment integration pending)',
      feature: feature.toObject(),
    };
  });
}
