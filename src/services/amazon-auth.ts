import fetch from 'node-fetch';
import { config } from '../config/env';

export type LwaTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number; // seconds
};

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

export async function exchangeCodeForTokens(code: string, redirectUri?: string): Promise<LwaTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.amazon.clientId,
    client_secret: config.amazon.clientSecret,
    redirect_uri: redirectUri || config.amazon.redirectUri,
  });

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LWA token exchange failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as LwaTokenResponse;
  return json;
}

export async function refreshAccessToken(refreshToken: string): Promise<LwaTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.amazon.clientId,
    client_secret: config.amazon.clientSecret,
  });

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LWA token refresh failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as LwaTokenResponse;
  return json;
}







