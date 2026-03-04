# Authentication Audit: Shopify & Amazon

This document audits the system's ability to authenticate with **Shopify** and **Amazon SP-API**, so you can confidently develop the rest of the APIs and calls.

---

## 1. Shopify Authentication

### Flow Overview

1. **Start** (`GET /api/v1/auth/shopify/start`) — User must be authenticated (Bearer token). Requires `shop` and `tenantId` query params. Creates OAuth state, returns redirect URL to Shopify consent.
2. **Callback** (`GET /api/v1/auth/shopify/callback`) — Shopify redirects here with `shop`, `code`, `state`, `hmac`. HMAC is verified, state validated, code exchanged for access token.
3. **Token exchange** — `POST https://{shop}/admin/oauth/access_token` with `client_id`, `client_secret`, `code`.
4. **Webhooks** — After auth, webhooks are registered for fulfillment orders, inventory, products.
5. **Storage** — `ChannelAccount` with `channel: 'shopify'`, `shopDomain`, `accessToken`.

### Required Environment Variables

| Variable | Purpose |
|----------|---------|
| `SHOPIFY_CLIENT_ID` | OAuth app client ID from Shopify Partners |
| `SHOPIFY_CLIENT_SECRET` | OAuth app client secret |
| `APP_BASE_URL` | Base URL of backend (e.g. `https://api.example.com`) — used for redirect_uri |

### Redirect URLs (Shopify Partners)

- **Redirect URL** must be: `{APP_BASE_URL}/api/v1/auth/shopify/callback`
- Add this in your Shopify app settings under "Allowed redirection URL(s)".

### Verification Checklist

- [ ] `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are set
- [ ] `APP_BASE_URL` matches your deployed backend (or ngrok/tunnel for local dev)
- [ ] Redirect URL is whitelisted in Shopify Partners
- [ ] Shop domain format: `myshop.myshopify.com` (or valid host)
- [ ] User is logged in before starting OAuth (401 if not)

### Auth Endpoints

| Endpoint | Method | Auth Required | Purpose |
|----------|--------|---------------|---------|
| `/api/v1/auth/shopify/start?shop=...&tenantId=...` | GET | Yes (Bearer) | Returns `{ url }` (JSON) or redirects to Shopify |
| `/api/v1/auth/shopify/callback` | GET | No (Shopify redirects) | Exchanges code, saves token, redirects to frontend |

---

## 2. Amazon SP-API Authentication

### Flow Overview

1. **Start** (`GET /api/v1/auth/amazon/start`) — User must be authenticated. Optional `region` (na/eu/fe), `redirectTo`. Creates OAuth state, returns redirect URL to Seller Central.
2. **Callback** (`GET /api/v1/auth/amazon/callback`) — Amazon redirects with `spapi_oauth_code` (or `code`), `state`, optionally `selling_partner_id`, `marketplace_ids`. Exchanges code for LWA tokens.
3. **Token exchange** — `POST https://api.amazon.com/auth/o2/token` with authorization_code grant.
4. **Storage** — `ChannelAccount` with `channel: 'amazon'`, `sellingPartnerId`, `marketplaceIds`, `lwaAccessToken`, `lwaRefreshToken`, `lwaAccessTokenExpiresAt`.
5. **SP-API calls** — Use LWA access token + AWS SigV4 signing for SP-API requests.

### Required Environment Variables

| Variable | Purpose |
|----------|---------|
| `AMAZON_LWA_CLIENT_ID` | Login with Amazon (LWA) client ID |
| `AMAZON_LWA_CLIENT_ID` (or `AMAZON_APP_ID`) | Application ID for Seller Central authorize URL |
| `AMAZON_LWA_CLIENT_SECRET` | LWA client secret |
| `AMAZON_LWA_REDIRECT_URI` or `APP_BASE_URL` | Redirect URI: `{APP_BASE_URL}/api/v1/auth/amazon/callback` |
| `AMAZON_SPAPI_AWS_ACCESS_KEY_ID` | AWS IAM credentials for SP-API signing |
| `AMAZON_SPAPI_AWS_SECRET_ACCESS_KEY` | AWS IAM secret key |
| `AMAZON_REGION` | `na`, `eu`, or `fe` (optional, default `na`) |

### Redirect URLs (Seller Central)

- Add redirect URI in your Amazon Developer Console (Seller Central app): `{APP_BASE_URL}/api/v1/auth/amazon/callback`
- Must match exactly (including trailing slash handling).

### Verification Checklist

- [ ] `AMAZON_LWA_CLIENT_ID` and `AMAZON_LWA_CLIENT_SECRET` are set
- [ ] `AMAZON_LWA_REDIRECT_URI` or `APP_BASE_URL` produces correct callback URL
- [ ] Redirect URI is whitelisted in Amazon Developer Console
- [ ] AWS IAM credentials (`AMAZON_SPAPI_AWS_*`) are for an IAM user with SP-API role
- [ ] User is logged in before starting OAuth

### Auth Endpoints

| Endpoint | Method | Auth Required | Purpose |
|----------|--------|---------------|---------|
| `/api/v1/auth/amazon/start` | GET | Yes (Bearer) | Returns `{ url }` (JSON) or redirects to Seller Central |
| `/api/v1/auth/amazon/callback` | GET | No (Amazon redirects) | Exchanges code, saves tokens, redirects to frontend |

### Token Refresh

- LWA access tokens expire (~1 hour). `amazon-spapi.ts` uses `ensureLwaAccessToken()` to auto-refresh using `lwaRefreshToken` before SP-API calls.
- `refreshAccessToken()` in `amazon-auth.ts` is used for this.

---

## 3. Shared Requirements

- **User JWT** — Both `/start` routes require a valid JWT (Bearer token or `unie-token` cookie).
- **OAuth State** — Stored in `OAuthState` collection with 10-minute expiry. Used to prevent CSRF and tie callback to user.
- **MongoDB** — `ChannelAccount`, `OAuthState`, `User` collections must be reachable.
- **CORS** — `FRONTEND_ORIGIN` / `CORS_ORIGINS` must include your frontend origin for browser OAuth flows.

---

## 4. Manual Verification Steps

### Shopify

1. Ensure `.env` has `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `APP_BASE_URL`.
2. Run the audit script: `npm run audit:auth`
3. Log in to the frontend, go to Dashboard, click **Connect Shopify**.
4. Enter shop domain (e.g. `mystore.myshopify.com`), submit.
5. Approve on Shopify. You should be redirected back with `?success=shopify`.
6. Confirm a `ChannelAccount` exists in MongoDB with `channel: 'shopify'` and non-empty `accessToken`.

### Amazon

1. Ensure `.env` has all Amazon variables listed above.
2. Run the audit script: `npm run audit:auth`
3. Log in, go to Dashboard, click **Connect Amazon**.
4. Authorize on Seller Central. Redirect back with `?success=amazon`.
5. Confirm a `ChannelAccount` exists with `channel: 'amazon'` and `lwaRefreshToken`.

---

## 5. Known Considerations

- **Shopify HMAC** — Callback validates HMAC when `hmac` query param is present. Ensures request came from Shopify.
- **Amazon selling_partner_id** — May be missing on some callbacks. `findOneAndUpdate` uses `sellingPartnerId: undefined`; first connect per user creates/updates by `userId` + `channel: 'amazon'`.
- **Shopify webhooks** — Registered after auth. Ensure `APP_BASE_URL` is publicly reachable for webhook delivery.
- **ngrok** — For local dev, use ngrok and set `APP_BASE_URL=https://xxx.ngrok.io`.
