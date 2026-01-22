import { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
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
  url.searchParams.set('application_id', config.amazon.clientId);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', cleanRedirectUri);
  url.searchParams.set('version', 'beta');
  return url.toString();
}

export async function amazonAuthRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/amazon/start', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const region = String((req.query as any)?.region || config.amazon.region || 'na').toLowerCase();
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
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const url = buildAuthorizeUrl(state, redirectUri, region);
    const wantsJson =
      String(req.headers.accept || '').includes('application/json') ||
      String((req.query as any)?.format || '').toLowerCase() === 'json';
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'oauth-start-pre',hypothesisId:'H5',location:'src/routes/amazon-auth.routes.ts:40',message:'amazon start config snapshot',data:{region,redirectUri,appBaseUrl:config.amazon.appBaseUrl,clientIdPresent:Boolean(config.amazon.clientId),clientSecretPresent:Boolean(config.amazon.clientSecret)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'oauth-start-pre',hypothesisId:'H4',location:'src/routes/amazon-auth.routes.ts:44',message:'amazon start wantsJson decision',data:{accept:req.headers.accept,format:(req.query as any)?.format,wantsJson,region},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    if (wantsJson) {
      return reply.send({ url });
    }
    return reply.redirect(url);
  });

  fastify.get('/auth/amazon/callback', async (req: any, reply) => {
    const { state, spapi_oauth_code: code, selling_partner_id, marketplace_ids } = req.query as any;
    if (!state || !code) return reply.code(400).send({ error: 'state and spapi_oauth_code are required' });

    const stateDoc = await OAuthState.findOneAndDelete({ provider: 'amazon', state: String(state) }).exec();
    if (!stateDoc) return reply.code(400).send({ error: 'Invalid or expired state' });

    const userDoc = await User.findById(stateDoc.userId).exec();
    if (!userDoc) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const token = await exchangeCodeForTokens(String(code), config.amazon.redirectUri);
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

      const account = await ChannelAccount.findOneAndUpdate(
        { userId: userDoc._id, channel: 'amazon', sellingPartnerId: selling_partner_id || undefined },
        {
          userId: userDoc._id,
          channel: 'amazon',
          sellingPartnerId: selling_partner_id || undefined,
          marketplaceIds: marketplaces,
          region: stateDoc.region,
          accessToken: token.access_token, // satisfy required field; short-lived
          refreshToken: token.refresh_token,
          lwaRefreshToken: token.refresh_token,
          lwaAccessToken: token.access_token,
          lwaAccessTokenExpiresAt: expiresAt,
          status: 'active',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();

      return reply.send({
        success: true,
        accountId: account?._id,
        sellingPartnerId: selling_partner_id,
        marketplaceIds: marketplaces,
        region: stateDoc.region,
        expiresAt,
      });
    } catch (err: any) {
      fastify.log.error({ err, state }, 'Amazon auth failed');
      return reply.code(500).send({ error: 'Amazon auth failed', detail: err?.message });
    }
  });
}


