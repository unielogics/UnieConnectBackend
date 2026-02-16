import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { config } from '../config/env';
import { exchangeCodeForTokens } from '../services/amazon-auth';
import { ChannelAccount } from '../models/channel-account';
import { User } from '../models/user';
import { OAuthState } from '../models/oauth-state';

function buildAuthorizeUrl(state: string, redirectUri: string, region: string) {
  const baseByRegion = {
    na: 'https://sellercentral.amazon.com/apps/authorize/consent',
    eu: 'https://sellercentral-europe.amazon.com/apps/authorize/consent',
    fe: 'https://sellercentral.amazon.co.jp/apps/authorize/consent',
  } as const;
  const base =
    baseByRegion[region as keyof typeof baseByRegion] ?? baseByRegion.na;
  const url = new URL(base);
  const cleanRedirectUri = redirectUri.trim().replace(/^=+/, '');
  url.searchParams.set('application_id', config.amazon.appId || config.amazon.clientId);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', cleanRedirectUri);
  url.searchParams.set('version', 'beta');
  return url.toString();
}

export async function amazonAuthRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/amazon/start', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const q = req.query as any;
    const region = String(q?.region || config.amazon.region || 'na').toLowerCase();
    const redirectTo = String(q?.redirectTo || '').trim() || undefined;
    const redirectUri = config.amazon.redirectUri || `${config.amazon.appBaseUrl}/api/v1/auth/amazon/callback`;

    if (!config.amazon.clientId || !config.amazon.clientSecret || !redirectUri) {
      return reply.code(500).send({ error: 'Amazon credentials not configured' });
    }

    const state = crypto.randomBytes(16).toString('hex');
    await OAuthState.create({
      provider: 'amazon',
      state,
      userId,
      region,
      redirectTo,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const url = buildAuthorizeUrl(state, redirectUri, region);
    const wantsJson =
      String(req.headers.accept || '').includes('application/json') ||
      String(q?.format || '').toLowerCase() === 'json' ||
      Boolean(req.headers.authorization);
    if (wantsJson) {
      return reply.send({ url });
    }
    return reply.redirect(url);
  });

  fastify.get('/auth/amazon/callback', async (req: any, reply) => {
    const q = req.query as any;
    const state = String(q?.state || '');
    const code = String(q?.spapi_oauth_code || q?.code || '');
    const selling_partner_id = q?.selling_partner_id;
    const marketplace_ids = q?.marketplace_ids;
    const errorParam = q?.error;
    const error_description = q?.error_description;

    if (errorParam) {
      fastify.log.warn({ error: errorParam, error_description }, 'Amazon OAuth error');
      return reply.redirect(
        `${config.frontendOrigin}/?error=amazon&message=${encodeURIComponent(error_description || errorParam)}`,
      );
    }

    if (!state || !code) {
      return reply.redirect(
        `${config.frontendOrigin}/?error=amazon&message=${encodeURIComponent('state and authorization code are required')}`,
      );
    }

    const stateDoc = await OAuthState.findOneAndDelete({ provider: 'amazon', state }).exec();
    if (!stateDoc) {
      return reply.redirect(
        `${config.frontendOrigin}/?error=amazon&message=${encodeURIComponent('Invalid or expired state')}`,
      );
    }

    const userDoc = await User.findById(stateDoc.userId).exec();
    if (!userDoc) {
      return reply.redirect(
        `${config.frontendOrigin}/?error=amazon&message=${encodeURIComponent('User not found')}`,
      );
    }

    const redirectBase = (stateDoc as any).redirectTo || config.frontendOrigin;
    const successUrl = `${redirectBase.replace(/\/+$/, '')}/?success=amazon`;

    try {
      const token = await exchangeCodeForTokens(code, config.amazon.redirectUri);
      const expiresAt = new Date(Date.now() + (token.expires_in || 0) * 1000);

      const marketplaces =
        typeof marketplace_ids === 'string'
          ? String(marketplace_ids)
              .split(',')
              .map((m) => m.trim())
              .filter(Boolean)
          : Array.isArray(marketplace_ids)
          ? (marketplace_ids as string[]).map((m) => String(m)).filter(Boolean)
          : [];

      await ChannelAccount.findOneAndUpdate(
        { userId: userDoc._id, channel: 'amazon', sellingPartnerId: selling_partner_id || undefined },
        {
          userId: userDoc._id,
          channel: 'amazon',
          sellingPartnerId: selling_partner_id || undefined,
          marketplaceIds: marketplaces,
          region: stateDoc.region,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          lwaRefreshToken: token.refresh_token,
          lwaAccessToken: token.access_token,
          lwaAccessTokenExpiresAt: expiresAt,
          status: 'active',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();

      return reply.redirect(successUrl);
    } catch (err: any) {
      fastify.log.error({ err, state }, 'Amazon auth failed');
      return reply.redirect(
        `${config.frontendOrigin}/?error=amazon&message=${encodeURIComponent(err?.message || 'Amazon auth failed')}`,
      );
    }
  });
}


