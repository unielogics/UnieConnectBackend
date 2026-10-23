# Shopify App Store AI Self Review

Review date: 2026-10-22

Source: `docs/shopify-app-store-ai-self-review-requirements.md`, fetched with the latest Shopify CLI as required by Shopify's AI self-review workflow.

## Summary

Likely passing: 28

Likely failing: 0

Needs review: 3

Groups skipped: 10

This review covers Shopify's locally checkable requirements. Shopify will evaluate these and additional requirements during App Store review.

## Requirements That Need Review

### Use Shopify App Pricing Or The Shopify Billing API

**Why this needs attention:** The codebase contains Stripe-backed OMS billing and operational warehouse charges. A human must confirm whether any of those charges are fees for the Shopify app itself. App charges must use Shopify App Pricing or the Billing API.

**What was detected:** Stripe billing code and paid OMS functionality exist, but the intended Shopify App Store plan and whether fulfillment-service charges are separate from app access are not documented.

### Implement Shopify App Pricing Or The Shopify Billing API Correctly

**Why this needs attention:** Correct implementation depends on the unresolved pricing model. This cannot be proven from the current code.

**What was detected:** No Shopify app subscription or one-time app purchase implementation was found.

### Allow Pricing Plan Changes

**Why this needs attention:** If the Shopify app has paid plans, merchants must be able to change plans through Shopify-compatible billing. If the listing is free, this requirement does not apply in practice.

**What was detected:** OMS billing controls exist, but no Shopify app-plan lifecycle is defined.

## Verified Shopify Checks

- Mandatory compliance topics are declared in `shopify.app.production.toml` and point to `/api/v1/webhooks/shopify/compliance`.
- Compliance and operational webhook handlers verify `X-Shopify-Hmac-Sha256` against the unmodified raw request body before processing.
- The embedded entry page loads the latest App Bridge script from Shopify's CDN.
- Embedded launch uses a Shopify ID token. The backend verifies signature, audience, issuer, destination, expiry, and tenant mapping before granting account access.
- First embedded launch exchanges the ID token for an expiring offline access token and stores it against the authenticated shop/account.
- Shopify catalog, order, customer, inventory, shop-profile, and webhook-registration calls use the GraphQL Admin API; the legacy REST pull module was removed.
- The OMS does not ask merchants to enter a `myshopify.com` domain. The Connect action opens Shopify's owned install/store-selection surface at `admin.shopify.com`.
- Embedded API requests obtain a fresh Shopify ID token through App Bridge; the backend verifies and maps that token to the connected account on every request.
- OAuth callback state and HMAC validation remain in place for the legacy standalone reconnection path.
- Public privacy, terms, support, and data-deletion pages exist.

## Skipped Groups

- **5.1 Online store** - No theme app extension detected.
- **5.2 Payment** - No payment app extension or payment gateway scope detected.
- **5.3 Payment facilitator** - Opt-in only; not requested.
- **5.4 Purchase option** - No subscription or purchase-option scopes detected.
- **5.5 Fulfillment service** - No Shopify fulfillment-service callback implementation detected; UnieConnect imports fulfillment data but does not register as a Shopify fulfillment service.
- **5.6 Checkout** - No checkout UI extension detected.
- **5.7 Sales channel** - No Shopify sales-channel extension detected.
- **5.8 Post-purchase** - No post-purchase extension detected.
- **5.9 Mobile app builder** - No mobile-app-builder extension detected.
- **5.10 Donations** - No donation app functionality detected.

## Manual Dashboard Work

- Add the monitored emergency contact email and phone number.
- Select English as the primary listing language.
- Complete listing content, screenshots, capabilities, pricing, and reviewer instructions.
- Log in to the development store and exercise the embedded app so Shopify's two-hour App Bridge and ID-token checks receive session evidence.
- Confirm whether Stripe invoices are exclusively physical warehouse, carrier, or fulfillment-service charges. If any charge pays for access to UnieConnect app functionality, replace that app charge with Shopify Managed Pricing or the Billing API.
- Do not mark the AI self-review complete until the three billing requirements are resolved for the intended App Store pricing model.

## Resources

- [App Store requirements documentation](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- [Best practices for apps](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices)
- [About billing for your app](https://shopify.dev/docs/apps/launch/billing)
- [Submitting your app for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
