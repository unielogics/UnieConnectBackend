# Shopify App Review Configuration

## Distribution and authentication

- Distribution: public Shopify App Store app
- App URL: `https://user.unieconnect.com/shopify`
- Allowed redirect URL: `https://api.unieconnect.com/api/v1/auth/shopify/callback`
- Embedded app: enabled in `shopify.app.production.toml`
- Primary listing language: English

The App URL validates the `shop` domain and any Shopify signature supplied with the request, creates a one-use OAuth state, and immediately redirects to Shopify authorization. The signed callback exchanges the authorization code, links the shop to its existing UnieConnect account or provisions a direct seller account, sets the UnieConnect session cookie, and redirects to the OMS Connections screen.

The embedded entry page loads the latest App Bridge script from Shopify's CDN, obtains an ID token, and exchanges it server-side for an expiring offline token. Every subsequent embedded request is authenticated with a newly supplied Shopify ID token and mapped to the connected store's UnieConnect account. The authorization-code endpoint remains available for existing standalone account reconnection, but must not be presented as the public App Store installation path.

The production Shopify synchronization path uses the GraphQL Admin API for shop profile, products, orders, customers, inventory, and webhook registration. The operations are captured in `docs/shopify-admin-sync.graphql` and validated against API version 2026-10.

## Compliance and public URLs

- Compliance webhook URL: `https://api.unieconnect.com/api/v1/webhooks/shopify/compliance`
- Privacy policy: `https://unieconnect.com/privacy`
- Terms of service: `https://unieconnect.com/terms`
- Support: `https://unieconnect.com/support`
- Data deletion instructions: `https://unieconnect.com/data-deletion`

Configure all mandatory compliance topics against the compliance webhook URL:

- `customers/data_request`
- `customers/redact`
- `shop/redact`

The endpoint verifies the Shopify HMAC against the raw request body before queuing any request. Normal Shopify operational webhooks also verify HMAC signatures.

## Scopes

Use the scopes in `shopify.app.toml.example`. Protected customer data access must match the merchant data used by order and customer synchronization.

## Manual Partner Dashboard fields

These values cannot be inferred or submitted by the application:

- Emergency contact email
- Emergency contact phone number
- App Store listing content, screenshots, pricing, and review instructions
- Final capability selections and review submission

Use a monitored technical contact and phone number. Do not enter a developer's temporary address or an unmonitored support alias.

## Current submission blockers

- Decide whether Shopify-originated accounts use Shopify as their only sign-in method or complete a secure password-setup flow for direct UnieConnect login.
- Confirm Shopify Billing API or managed pricing behavior before listing any paid plans.
- Add the emergency contact, primary language, listing content, screenshots, pricing, capabilities, and reviewer instructions in Dev Dashboard.

## Review test

1. Open the app from an authorized Shopify development store.
2. Confirm Shopify authorization appears immediately when the app is not installed.
3. Approve scopes and confirm Shopify opens `https://user.unieconnect.com/shopify`, which exchanges the ID token and opens the account-scoped OMS without a separate login gate.
4. Confirm the store appears connected and initial synchronization begins.
5. Create or update a product and order, then confirm webhook activity is reflected in UnieConnect.
6. Send correctly signed test compliance webhooks and confirm HTTP 200; send an invalid signature and confirm HTTP 401.

