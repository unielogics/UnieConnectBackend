/**
 * Authentication Audit Script
 *
 * Verifies that Shopify and Amazon authentication is correctly configured
 * and that auth flows can be initiated. Run before developing further APIs.
 *
 * Usage: npm run audit:auth
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

type CheckResult = { ok: boolean; message: string };

function check(name: string, condition: boolean, message: string): CheckResult {
  const ok = condition;
  return { ok, message: `${name}: ${ok ? '✓' : '✗'} ${message}` };
}

function main() {
  const results: CheckResult[] = [];

  // ---- Shopify ----
  const shopifyClientId = process.env.SHOPIFY_CLIENT_ID || '';
  const shopifyClientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  const appBaseUrl = process.env.APP_BASE_URL || '';

  results.push(
    check('Shopify', !!shopifyClientId, `SHOPIFY_CLIENT_ID ${shopifyClientId ? 'set' : 'missing'}`)
  );
  results.push(
    check('Shopify', !!shopifyClientSecret, `SHOPIFY_CLIENT_SECRET ${shopifyClientSecret ? 'set' : 'missing'}`)
  );
  results.push(
    check('Shopify', !!appBaseUrl, `APP_BASE_URL ${appBaseUrl ? `set (${appBaseUrl})` : 'missing'}`)
  );

  const shopifyCallbackUrl = appBaseUrl
    ? `${appBaseUrl.replace(/\/+$/, '')}/api/v1/auth/shopify/callback`
    : '';
  results.push(
    check('Shopify', !!shopifyCallbackUrl, `Callback URL: ${shopifyCallbackUrl || 'N/A'}`)
  );

  const shopifyReady = !!shopifyClientId && !!shopifyClientSecret && !!appBaseUrl;
  results.push(
    check('Shopify', shopifyReady, shopifyReady ? 'Credentials ready for OAuth' : 'Incomplete - fix env vars above')
  );

  // ---- Amazon ----
  const amazonClientId = process.env.AMAZON_LWA_CLIENT_ID || process.env.AMAZON_CLIENT_ID || '';
  const amazonClientSecret =
    process.env.AMAZON_LWA_CLIENT_SECRET || process.env.AMAZON_CLIENT_SECRET || '';
  const amazonRedirectUri =
    process.env.AMAZON_LWA_REDIRECT_URI ||
    (appBaseUrl ? `${appBaseUrl.replace(/\/+$/, '')}/api/v1/auth/amazon/callback` : '');
  const amazonAwsKey = process.env.AMAZON_SPAPI_AWS_ACCESS_KEY_ID || '';
  const amazonAwsSecret = process.env.AMAZON_SPAPI_AWS_SECRET_ACCESS_KEY || '';

  results.push(
    check('Amazon', !!amazonClientId, `AMAZON_LWA_CLIENT_ID ${amazonClientId ? 'set' : 'missing'}`)
  );
  results.push(
    check('Amazon', !!amazonClientSecret, `AMAZON_LWA_CLIENT_SECRET ${amazonClientSecret ? 'set' : 'missing'}`)
  );
  results.push(
    check('Amazon', !!amazonRedirectUri, `Redirect URI: ${amazonRedirectUri || 'N/A'}`)
  );
  results.push(
    check('Amazon', !!amazonAwsKey, `AMAZON_SPAPI_AWS_ACCESS_KEY_ID ${amazonAwsKey ? 'set' : 'missing'}`)
  );
  results.push(
    check('Amazon', !!amazonAwsSecret, `AMAZON_SPAPI_AWS_SECRET_ACCESS_KEY ${amazonAwsSecret ? 'set' : 'missing'}`)
  );

  const amazonOAuthReady = !!amazonClientId && !!amazonClientSecret && !!amazonRedirectUri;
  const amazonSpApiReady = !!amazonAwsKey && !!amazonAwsSecret;
  results.push(
    check('Amazon', amazonOAuthReady, amazonOAuthReady ? 'LWA OAuth credentials ready' : 'LWA OAuth incomplete')
  );
  results.push(
    check('Amazon', amazonSpApiReady, amazonSpApiReady ? 'SP-API AWS credentials ready' : 'SP-API AWS credentials missing')
  );

  // ---- Shared ----
  const dbUrl = process.env.DB_URL || '';
  const authSecret = process.env.AUTH_SECRET || '';
  results.push(check('Shared', !!dbUrl, `DB_URL ${dbUrl ? 'set' : 'missing'}`));
  const authSecretOk = Boolean(authSecret && authSecret !== 'change-me');
  results.push(check('Shared', authSecretOk, `AUTH_SECRET ${authSecretOk ? 'set' : 'missing or default'}`));

  // ---- Output ----
  console.log('\n=== Authentication Audit: Shopify & Amazon ===\n');
  results.forEach((r) => {
    console.log(r.message);
  });

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);

  console.log('\n--- Summary ---');
  console.log(`Passed: ${passed.length} | Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFix the failed checks above before running OAuth flows.');
    console.log('See docs/AUTH_AUDIT.md for full verification steps.\n');
    process.exit(1);
  }

  console.log('\n✓ All configuration checks passed. Ready to run OAuth flows.');
  console.log('  Next: Start backend, log in to dashboard, and connect Shopify/Amazon.\n');
  process.exit(0);
}

main();
