# Shopify: What UnieConnect Can Do & How to Verify

After a successful OAuth connection, UnieConnect uses the **Shopify Admin API** for orders, products, inventory, and fulfillment. This doc lists implemented capabilities and how to verify they work. UnieConnect mirrors the inventory and order management approach used with Amazon SP-API.

---

## 1. Required configuration (besides OAuth)

Shopify OAuth requires app credentials. Set in env:

| Env variable | Purpose |
|--------------|--------|
| `SHOPIFY_CLIENT_ID` | Shopify app client ID |
| `SHOPIFY_CLIENT_SECRET` | Shopify app client secret |
| `SHOPIFY_WEBHOOK_SECRET` | Webhook HMAC verification |
| `APP_BASE_URL` | Base URL for OAuth callback and webhooks (e.g. `https://api.unieconnect.com`) |

The OAuth scope includes: `read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_inventory,write_inventory,read_fulfillments,write_fulfillments`.

---

## 2. What UnieConnect does with Shopify

| Capability | Backend route / trigger | Shopify API used | Notes |
|------------|-------------------------|------------------|-------|
| **Orders pull** | `POST /api/v1/channel-accounts/:id/refresh` or cron every 30 min | `GET /orders.json` | Last 7 days (90 days on first sync), limit 50 |
| **Products pull** | Same as above | `GET /products.json` | Limit 250 |
| **Inventory pull** | Same as above | `GET /locations.json`, `GET /inventory_levels.json` | First location, limit 250 |
| **Sync status** | `GET /api/v1/channel-accounts/:id/sync-status` | N/A | Per-entity status (products, orders, inventory, customers) |
| **Inventory push** | `POST /api/v1/shopify/inventory` | `POST /inventory_levels/set.json` | Updates quantity per SKU |
| **Create fulfillment** | `POST /api/v1/shopify/fulfillment` | `GET /orders/:id/fulfillment_orders.json`, `POST /fulfillments.json` | Mark order as fulfilled, optional tracking |
| **Webhooks** | Incoming from Shopify | `products/update`, `inventory_levels/update`, `orders/create`, `orders/updated` | Real-time updates |

Label quote/purchase endpoints exist but return 501 (Shopify Shipping labels not available via Admin API for custom apps).

**Note:** Existing connected shops will not receive `orders/create` and `orders/updated` webhooks until they disconnect and re-authorize the Shopify app (or until webhooks are re-registered via a migration). New connections will have order webhooks registered automatically.

---

## 3. How to verify

### 3.1 Connection and account

- **Dashboard:** Log in → Integrations → Shopify should show **Connected** with the shop domain.
- **API:**  
  `GET /api/v1/channel-accounts` with `Authorization: Bearer <token>`  
  Response should include an account with `channel: "shopify"`, `status: "active"`, and `shopDomain`.

### 3.2 Sync status

- **Dashboard:** Open the Shopify integration, click **Manage**. A sync status panel shows Products, Orders, Inventory, and Customers with status (Syncing / Synced / Error) and counts.
- **API:**  
  `GET /api/v1/channel-accounts/:id/sync-status` with `Authorization: Bearer <token>`  
  Replace `:id` with the Shopify channel account id. Returns `entities`, `fullSync`, per-entity counts and lastSyncedAt.

### 3.3 Orders pull (refresh)

- **Dashboard:** Click **Refresh** in the Shopify card. No error means the backend successfully pulled products, orders, and inventory.
- **API:**  
  `POST /api/v1/channel-accounts/:id/refresh` with `Authorization: Bearer <token>`  
  Response: `{ success: true, syncResult: { products, orders, inventory } }`  
  Backend logs: `shopify refresh completed` with counts.

### 3.4 Inventory push

- **API:**  
  `POST /api/v1/shopify/inventory`  
  Body: `{ "accountId": "<channel-account-id>", "updates": [ { "sku": "<your-sku>", "quantity": 5 } ] }`  
  Use a SKU that exists in the connected Shopify store and has been synced. Success means inventory was updated in Shopify. Verify in Shopify admin.

### 3.5 Order fulfillment

- **API:**  
  `POST /api/v1/shopify/fulfillment`  
  Body: `{ "accountId": "<channel-account-id>", "externalOrderId": "<shopify-order-id>", "trackingNumber": "1Z999...", "trackingCompany": "UPS", "notifyCustomer": true }`  
  Use a real Shopify order ID (the numeric ID from Shopify). Success means the order is marked as fulfilled. Verify in Shopify admin.

---

## 4. Quick verification checklist

1. **OAuth (auth)** – Shopify shows Connected in the app; `GET /api/v1/channel-accounts` returns the Shopify account.
2. **Env** – `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `APP_BASE_URL` are set.
3. **Sync status** – `GET /api/v1/channel-accounts/:id/sync-status` returns entities after first refresh.
4. **Refresh** – `POST /api/v1/channel-accounts/:id/refresh` returns 200 and `syncResult` with counts.
5. **Inventory push** – `POST /api/v1/shopify/inventory` with valid `accountId` and SKU returns success.
6. **Fulfillment** – `POST /api/v1/shopify/fulfillment` with valid order ID returns success.

Checking backend logs after each action (refresh, inventory, fulfillment) is the most reliable way to confirm what Shopify API calls ran and whether they succeeded or failed.

---

## 5. Shopify API references

- [REST Admin API](https://shopify.dev/docs/api/admin-rest)
- [Fulfillment](https://shopify.dev/docs/api/admin-rest/latest/resources/fulfillment)
- [InventoryLevel](https://shopify.dev/docs/api/admin-rest/latest/resources/inventorylevel)
- [FulfillmentOrder](https://shopify.dev/docs/api/admin-rest/latest/resources/fulfillmentorder)
