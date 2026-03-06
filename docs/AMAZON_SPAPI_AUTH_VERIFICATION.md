# Amazon SP-API Auth Workflow Verification (PrepCenterNearMe vs UnieConnect)

This document summarizes how **PrepCenterNearMe_system** builds the Amazon authorize link (working flow) for comparison with UnieConnect.

---

## PrepCenterNearMe_system – Working Flow

### 1. Entry point (frontend)

- User clicks Connect for Amazon.
- Frontend generates a **nonce** and opens the backend URL in a new tab:
  - `GET ${API_URL}/amazon/connect/${nonce}?email=${email}`
  - Example: `https://api.prepcenternearme.com/amazon/connect/abc123?email=user@example.com`

### 2. Backend – build authorize URL (`amazon.routes.js`)

**Route:** `GET /amazon/connect/:nonce`

- Reads from env: `SPAPI_APP_ID`, `SPAPI_REDIRECT_URI`.
- Stores **nonce** for the user (by email from query).
- Builds **state**: `base64(JSON.stringify({ email, nonce }))`.
- Builds the **authorize URL**:

```javascript
const redirect = `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${appId}&state=${stateEncoded}&redirect_uri=${encodeURIComponent(redirectUri)}&version=beta`;
```

- Responds with **HTTP 302 redirect** to that URL (user is sent to Seller Central).

### 3. Query parameters (exact shape)

| Parameter        | Source                    | Example / note                                                                 |
|-----------------|---------------------------|-------------------------------------------------------------------------------|
| `application_id`| `SPAPI_APP_ID` (or `APP_ID` in controller) | LWA app id, e.g. `amzn1.application-oa2-client.xxx`                         |
| `state`         | Base64 of `{ email, nonce }` | Stored server-side; validated on callback                                    |
| `redirect_uri`  | `SPAPI_REDIRECT_URI` or `REDIRECT_URI` | **Single env var**; must match SP-API dashboard exactly; used **encoded** in URL |
| `version`       | Literal `"beta"`          | Required for consent URL                                                      |

### 4. Callback

- Amazon redirects to `REDIRECT_URI` with `code` (or `spapi_oauth_code`), `state`, `selling_partner_id`, etc.
- Backend decodes **state** → `email`, `nonce`; validates nonce; exchanges **code** for tokens at `https://api.amazon.com/auth/o2/token` using the **same** `redirect_uri` and client credentials.

### 5. Config (PrepCenterNearMe)

- **Single redirect URI** in env: `REDIRECT_URI` or `SPAPI_REDIRECT_URI`.
- No derivation from “app base URL”; redirect URI is configured once and must match the SP-API dashboard.

---

## UnieConnect – Current Flow (aligned)

| Aspect           | PrepCenterNearMe                    | UnieConnect                                              |
|-----------------|-------------------------------------|----------------------------------------------------------|
| Authorize host  | `sellercentral.amazon.com`          | Same (NA); EU/FE use `sellercentral-europe.amazon.com` etc. |
| Query params    | `application_id`, `state`, `redirect_uri`, `version=beta` | Same set.                                                |
| State           | Base64 `{ email, nonce }`           | Random hex stored in `OAuthState`                        |
| Redirect URI    | Single env `REDIRECT_URI`            | From `APP_BASE_URL` + `/api/v1/auth/amazon/callback` (or `AMAZON_LWA_REDIRECT_URI` when set). |
| Link building   | `encodeURIComponent(redirectUri)` in template string | `URL` + `searchParams.set('redirect_uri', ...)` (auto-encoded). |

UnieConnect’s URL shape and parameter set match the working PrepCenterNearMe pattern. The important part is that **redirect_uri** sent in the authorize request is **exactly** the value registered in the SP-API dashboard (e.g. `https://api.unieconnect.com/api/v1/auth/amazon/callback`).

---

## Build-the-link formula (for manual verification)

Use the same structure as PrepCenterNearMe:

```
https://sellercentral.amazon.com/apps/authorize/consent?application_id=APPLICATION_ID&state=STATE&redirect_uri=REDIRECT_URI_ENCODED&version=beta
```

- **APPLICATION_ID**: Your LWA app id (e.g. from `AMAZON_APP_ID` or `AMAZON_LWA_CLIENT_ID`).
- **STATE**: For a real flow, must be a state your backend created (e.g. from `/auth/amazon/start` with auth). For link shape verification only, any base64 string is fine.
- **REDIRECT_URI_ENCODED**: `encodeURIComponent('https://api.unieconnect.com/api/v1/auth/amazon/callback')` → `https%3A%2F%2Fapi.unieconnect.com%2Fapi%2Fv1%2Fauth%2Famazon%2Fcallback`.

Example (replace APPLICATION_ID and STATE for a live test):

```
https://sellercentral.amazon.com/apps/authorize/consent?application_id=amzn1.application-oa2-client.XXX&state=YOUR_STATE&redirect_uri=https%3A%2F%2Fapi.unieconnect.com%2Fapi%2Fv1%2Fauth%2Famazon%2Fcallback&version=beta
```

To get a **valid** link (with state your backend will accept), call UnieConnect’s start endpoint and use the returned `url`:

```bash
curl -s -H "Authorization: Bearer YOUR_JWT" -H "Accept: application/json" "https://api.unieconnect.com/api/v1/auth/amazon/start?format=json"
# Use the "url" value from the JSON response.
```

---

## Summary

- PrepCenterNearMe builds the authorize link on the backend with a **single env redirect URI**, and uses **querystring/encodeURIComponent** so `redirect_uri` is correctly encoded.
- UnieConnect builds the same consent URL (same host and params) and encodes `redirect_uri` via `URL.searchParams`. The workflow is equivalent; the critical requirement is that the **redirect_uri** value (after decoding) matches the **OAuth Redirect URI** in the SP-API dashboard exactly.
