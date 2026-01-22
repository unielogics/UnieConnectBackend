import dotenv from 'dotenv';
import path from 'path';

// Explicitly load .env from project root to avoid cwd issues.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const normalizeRedirectUri = (value: string) => value.trim().replace(/^=+/, '');

export const config = {
  port: Number(process.env.PORT || 4000),
  rabbitUrl: process.env.RABBITMQ_URL || '',
  shopify: {
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
    appBaseUrl: process.env.APP_BASE_URL || '', // e.g., https://connect.example.com
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
  },
  ebay: {
    clientId: process.env.EBAY_CLIENT_ID || '',
    clientSecret: process.env.EBAY_CLIENT_SECRET || '',
    ruName: process.env.EBAY_RU_NAME || '', // eBay Redirect URI (RuName)
    redirectUri: process.env.EBAY_REDIRECT_URI || process.env.EBAY_RU_NAME || '',
    scope:
      process.env.EBAY_SCOPE ||
      [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
      ].join(' '),
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
    apiBaseUrl: process.env.EBAY_API_BASE_URL || 'https://api.ebay.com',
    authBaseUrl: process.env.EBAY_AUTH_BASE_URL || 'https://auth.ebay.com',
  },
  amazon: {
    clientId: process.env.AMAZON_LWA_CLIENT_ID || '',
    clientSecret: process.env.AMAZON_LWA_CLIENT_SECRET || '',
    appBaseUrl: process.env.APP_BASE_URL || '',
    redirectUri: normalizeRedirectUri(
      process.env.AMAZON_LWA_REDIRECT_URI ||
        `${process.env.APP_BASE_URL || ''}/api/v1/auth/amazon/callback`,
    ),
    region: process.env.AMAZON_REGION || 'na', // na, eu, fe
    awsAccessKeyId: process.env.AMAZON_SPAPI_AWS_ACCESS_KEY_ID || '',
    awsSecretAccessKey: process.env.AMAZON_SPAPI_AWS_SECRET_ACCESS_KEY || '',
    awsSessionToken: process.env.AMAZON_SPAPI_AWS_SESSION_TOKEN || '',
  },
  dbUrl: process.env.DB_URL || '',
  authSecret: process.env.AUTH_SECRET || 'change-me',
  rateShopping: {
    apiUrl: process.env.RATE_SHOPPING_API_URL || '',
    apiKey: process.env.RATE_SHOPPING_API_KEY || '',
    ttlMs: Number(process.env.RATE_SHOPPING_TTL_MS || 7 * 24 * 60 * 60 * 1000), // default 7 days
  },
  shippo: {
    apiKey: process.env.SHIPPO_API_KEY || '',
    mockMode: String(process.env.SHIPPO_MOCK_MODE || '').toLowerCase() === 'true',
    defaultFrom: {
      city: process.env.SHIPPO_FROM_CITY || 'Los Angeles',
      state: process.env.SHIPPO_FROM_STATE || 'CA',
      postalCode: process.env.SHIPPO_FROM_POSTAL || '90001',
      country: process.env.SHIPPO_FROM_COUNTRY || 'US',
    },
  },
  geoapify: {
    apiKey: process.env.GEOAPIFY_API_KEY || '',
  },
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
};

