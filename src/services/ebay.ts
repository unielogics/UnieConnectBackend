import fetch from 'node-fetch';
import { URLSearchParams } from 'url';
import { config } from '../config/env';

type EbayTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
};

const EBAY_TOKEN_ENDPOINT = `${config.ebay.apiBaseUrl}/identity/v1/oauth2/token`;

export function buildEbayAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: config.ebay.clientId,
    redirect_uri: config.ebay.ruName,
    response_type: 'code',
    scope: config.ebay.scope,
    state,
  });
  return `${config.ebay.authBaseUrl}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeEbayCodeForToken(code: string) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.ebay.ruName,
  });
  return performTokenRequest(body);
}

export async function refreshEbayAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: config.ebay.scope,
  });
  return performTokenRequest(body);
}

async function performTokenRequest(body: URLSearchParams) {
  const clientId = config.ebay.clientId;
  const clientSecret = config.ebay.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error('EBAY_CLIENT_ID or EBAY_CLIENT_SECRET not configured');
  }

  const res = await fetch(EBAY_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay token request failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as EbayTokenResponse;
  const expiresAt = json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined;
  const refreshExpiresAt = json.refresh_token_expires_in
    ? new Date(Date.now() + json.refresh_token_expires_in * 1000)
    : undefined;

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt,
    refreshExpiresAt,
    raw: json,
  };
}

export async function ebayGet<T = any>(path: string, accessToken: string, opts?: { marketplaceId?: string }) {
  const marketplaceId = opts?.marketplaceId || config.ebay.marketplaceId;
  const res = await fetch(`${config.ebay.apiBaseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay GET ${path} failed (${res.status}): ${text}`);
  }

  return (await res.json()) as T;
}


