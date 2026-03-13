# Shopify Webhook Debug Checklist

Use this checklist when Shopify orders are not appearing and webhooks are not working on the live server.

---

## 1. Verify Config (API)

**GET** `https://api.unieconnect.com/api/v1/channel-accounts/:shopifyAccountId/debug`  
(Requires `Authorization: Bearer <token>` — use the account ID from `GET /channel-accounts`)

Check the response:

- `shopifyConfig.appBaseUrl` → `https://api.unieconnect.com`
- `shopifyConfig.webhookAddress` → `https://api.unieconnect.com/api/v1/webhooks/shopify`
- `shopifyConfig.apiVersion` → valid (e.g. `2024-01`). If `2026-01` or other future/unsupported version, change to `2024-01`.
- `shopifyConfig.hasWebhookSecret` → `true`
- `shopifyConfig.redirectUri` → `https://api.unieconnect.com/api/v1/auth/shopify/callback`

---

## 2. Shopify Partners App Settings

In **Shopify Partners** → **Apps** → **Your app** → **Configuration**:

| Setting | Expected |
|---------|----------|
| **App URL** | `https://api.unieconnect.com` or your API base |
| **Allowed redirection URL(s)** | Must include `https://api.unieconnect.com/api/v1/auth/shopify/callback` |

Use **Client credentials** to confirm `client_id` and `client_secret` match your `.env`.

---

## 3. Environment Variables (Production)

| Variable | Purpose |
|----------|---------|
| `APP_BASE_URL` | Base URL for OAuth redirect and webhooks. Must be `https://api.unieconnect.com` in prod. |
| `SHOPIFY_CLIENT_ID` | Matches Partners app |
| `SHOPIFY_CLIENT_SECRET` | Matches Partners app |
| `SHOPIFY_WEBHOOK_SECRET` | Must match the **Webhook subscription API** signing secret in Partners app settings |
| `SHOPIFY_API_VERSION` | Use `2024-01` or `2024-10` (avoid unsupported versions) |

**Webhook secret:** In Partners app settings, under **Webhooks**, check for a signing secret. If shown, it must equal `SHOPIFY_WEBHOOK_SECRET`. Many apps reuse `SHOPIFY_CLIENT_SECRET` as the webhook signing secret; confirm this matches your setup.

---

## 4. Reconnect Flow and Logs

1. Disconnect the store in the app.
2. Connect again (full OAuth flow).
3. Inspect production logs during reconnect.

Look for:

```
[Shopify OAuth] token exchange start
[Shopify OAuth] token exchange ok
[Shopify OAuth] webhook registration config  { shop, address, appBaseUrl, apiVersion }
[Shopify] registerWebhooks start
[Shopify] registerWebhooks existing count
[Shopify] registerWebhooks created   (per topic)
[Shopify] registerWebhooks done     { created, totalTopics }
[Shopify OAuth] webhooks registered, saving account
[Shopify OAuth] callback success
```

If you see:

- `[Shopify] webhook list failed` → API version or token problem.
- `[Shopify] webhook create failed` → Shopify rejected the webhook (URL, permissions, etc.).
- `[Shopify OAuth] callback failed` → Full error and stack trace.

---

## 5. Verify Webhooks in Store Admin

1. In the **store admin**, go to **Settings** → **Notifications** → **Webhooks**.
2. Confirm webhooks exist for:
   - `orders/create`
   - `orders/updated`
   - `products/update`
   - `inventory_levels/update`
3. Each should point to `https://api.unieconnect.com/api/v1/webhooks/shopify`.

If none appear after reconnect, registration failed (see step 4 logs).

---

## 6. Incoming Webhook Logs

When Shopify sends a webhook, logs should show:

```
[Shopify Webhook] received   { topic, shopDomain }
[Shopify Webhook] ok
```

If you see:

- `Invalid signature` → `SHOPIFY_WEBHOOK_SECRET` does not match Shopify’s signing secret.
- `account not found` → `shopDomain` from header doesn’t match any `ChannelAccount.shopDomain` (check `knownShops` in the log).
- `handling failed` → Error details in the log.

---

## 7. Shop Domain Matching

The webhook handler looks up the account by `x-shopify-shop-domain` (e.g. `mystore.myshopify.com`).

`ChannelAccount.shopDomain` must match exactly. Check:

- DB: `db.channelaccounts.find({ channel: 'shopify' })` → `shopDomain` values.
- Logs when webhook fails: `knownShops` vs incoming `shopDomain` (trailing dot, `www`, etc.).

---

## 8. Manual Order Sync (Temporary Workaround)

Orders are also pulled by the cron (every ~30 minutes). Use **Refresh** on the Shopify integration to trigger an immediate sync. If orders appear after refresh, webhooks are the main issue.

---

## Quick Actions

1. Set `SHOPIFY_API_VERSION=2024-01` in production env.
2. Redeploy.
3. Disconnect and reconnect the store.
4. Watch logs during reconnect.
5. Confirm webhooks in store admin.
6. Create a test order and check logs for `[Shopify Webhook] received`.
