import fetch, { RequestInit } from 'node-fetch';
// aws4 has no bundled types; use require to avoid TS complaints under strict mode
// eslint-disable-next-line @typescript-eslint/no-var-requires
const aws4 = require('aws4') as any;

import { config } from '../config/env';
import { ChannelAccount, IChannelAccount } from '../models/channel-account';
import { refreshAccessToken } from './amazon-auth';

type SpApiRequest = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Record<string, string | number | boolean | undefined | Array<string | number>>;
  body?: any;
};

const HOST_BY_REGION: Record<string, string> = {
  na: 'sellingpartnerapi-na.amazon.com',
  eu: 'sellingpartnerapi-eu.amazon.com',
  fe: 'sellingpartnerapi-fe.amazon.com',
};

function buildQueryString(query?: SpApiRequest['query']): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function ensureLwaAccessToken(account: IChannelAccount): Promise<string> {
  const now = Date.now();
  const expiresAt = account.lwaAccessTokenExpiresAt ? new Date(account.lwaAccessTokenExpiresAt).getTime() : 0;
  // Refresh if expiring in <2 minutes
  if (account.lwaAccessToken && expiresAt - now > 2 * 60 * 1000) {
    return account.lwaAccessToken;
  }
  if (!account.lwaRefreshToken) {
    throw new Error('LWA refresh token missing for Amazon account');
  }
  const refreshed = await refreshAccessToken(account.lwaRefreshToken);
  const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 0) * 1000);
  await ChannelAccount.updateOne(
    { _id: account._id },
    {
      lwaAccessToken: refreshed.access_token,
      lwaAccessTokenExpiresAt: newExpiresAt,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || account.refreshToken,
    },
  ).exec();
  return refreshed.access_token;
}

export async function spApiFetch(account: IChannelAccount, req: SpApiRequest): Promise<any> {
  const region = (account.region || config.amazon.region || 'na').toLowerCase();
  const host = HOST_BY_REGION[region] || HOST_BY_REGION.na;
  const accessToken = await ensureLwaAccessToken(account);

  const queryString = buildQueryString(req.query);
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
  const fullPath = `${path}${queryString}`;
  const url = `https://${host}${fullPath}`;

  const bodyString =
    req.body === undefined || req.body === null
      ? undefined
      : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

  const requestOptions: RequestInit = {
    method: req.method || 'GET',
    headers: {
      host,
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), // basic ISO -> yyyymmddThhmmssZ
    } as any,
    body: bodyString,
  };

  const signingOpts = {
    host,
    method: requestOptions.method,
    path: fullPath,
    service: 'execute-api',
    region,
    headers: requestOptions.headers,
    body: bodyString,
  };

  const awsCreds = {
    accessKeyId: config.amazon.awsAccessKeyId,
    secretAccessKey: config.amazon.awsSecretAccessKey,
    sessionToken: config.amazon.awsSessionToken || undefined,
  };
  if (!awsCreds.accessKeyId || !awsCreds.secretAccessKey) {
    throw new Error('Amazon SP-API AWS credentials are not configured');
  }

  aws4.sign(signingOpts, awsCreds);

  // aws4 mutated headers with signature; copy them over
  requestOptions.headers = signingOpts.headers;

  return executeWithRetry(url, requestOptions);
}

async function executeWithRetry(url: string, options: RequestInit, attempt = 1): Promise<any> {
  const maxAttempts = 3;
  const res = await fetch(url, options);
  const text = await res.text();
  const isJson = text.startsWith('{') || text.startsWith('[');
  const payload = isJson ? JSON.parse(text) : text;

  if (res.ok) return payload;

  const status = res.status;
  const retryAfter = Number(res.headers.get('retry-after')) || undefined;
  const rateLimited = status === 429;
  const transient = status === 500 || status === 503;

  if ((rateLimited || transient) && attempt < maxAttempts) {
    const backoff = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 5000);
    await new Promise((r) => setTimeout(r, backoff));
    return executeWithRetry(url, options, attempt + 1);
  }

  const msg = (payload as any)?.message || (payload as any)?.errors || payload;
  throw new Error(`SP-API ${status}: ${JSON.stringify(msg)}`);
}


