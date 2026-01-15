import dotenv from 'dotenv';
import path from 'path';

// Explicitly load .env from project root to avoid cwd issues.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

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
    redirectUri:
      process.env.AMAZON_LWA_REDIRECT_URI ||
      `${process.env.APP_BASE_URL || ''}/api/v1/auth/amazon/callback`,
    region: process.env.AMAZON_REGION || 'na', // na, eu, fe
    awsAccessKeyId: process.env.AMAZON_SPAPI_AWS_ACCESS_KEY_ID || '',
    awsSecretAccessKey: process.env.AMAZON_SPAPI_AWS_SECRET_ACCESS_KEY || '',
    awsSessionToken: process.env.AMAZON_SPAPI_AWS_SESSION_TOKEN || '',
  },
  dbUrl: process.env.DB_URL || '',
  authSecret: process.env.AUTH_SECRET || 'change-me',
};

