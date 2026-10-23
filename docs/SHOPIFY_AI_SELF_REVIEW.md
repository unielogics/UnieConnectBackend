# Shopify App Store AI Self Review

Review date: 2026-10-22

Source: `docs/shopify-app-store-ai-self-review-requirements.md`, fetched with the latest Shopify CLI as required by Shopify's AI self-review workflow.

## Summary

Likely passing: 31

Likely failing: 0

Needs review: 0

Groups skipped: 10

This review covers Shopify's locally checkable requirements. Shopify will evaluate these and additional requirements during App Store review.

## Billing Policy Determination

UnieConnect is free for Shopify merchants to install and use. There are no paid Shopify app plans, feature-access fees, or one-time app purchases.

Warehouse providers fund the merchant's access to the UnieConnect ecosystem. Stripe is used only for separately ordered real-world logistics services, such as warehouse handling, carrier charges, and physical fulfillment. Stripe is not used to sell access to the Shopify app or its software features.

Based on this confirmed commercial model, the three app-billing requirements are satisfied for the free listing:

- **Use Shopify App Pricing or the Shopify Billing API:** no Shopify app charge exists.
- **Implement Shopify app billing correctly:** no paid app plan or app purchase is offered.
- **Allow pricing-plan changes:** not applicable because the app has no paid plans.

Merchant-facing payment copy must continue to identify Stripe charges as optional physical logistics-service charges and state that Shopify app access is free.

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
- Complete listing content, screenshots, capabilities, and reviewer instructions. Set the App Store pricing to **Free**.
- Log in to the development store and exercise the embedded app so Shopify's two-hour App Bridge and ID-token checks receive session evidence.
- In reviewer notes, disclose that Stripe is limited to separately ordered warehouse, carrier, and physical fulfillment services and is never used for app access.
- The locally checkable AI self-review requirements are complete. The Partner Dashboard checkbox can be marked after the remaining manual fields above are completed and verified.

## Resources

- [App Store requirements documentation](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- [Best practices for apps](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices)
- [About billing for your app](https://shopify.dev/docs/apps/launch/billing)
- [Submitting your app for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
