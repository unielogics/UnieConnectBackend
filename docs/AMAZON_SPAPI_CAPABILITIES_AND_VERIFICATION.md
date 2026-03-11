# Amazon SP-API: What UnieConnect Can Do & How to Verify

After a successful LWA connection, UnieConnect uses **Selling Partner API (SP-API)** for orders, inventory, fulfillment, inbound, and shipping. This doc lists implemented capabilities and how to verify they work.

---

## 1. Required configuration (besides LWA)

SP-API requests are signed with **AWS credentials** (IAM user with SP-API role). Set in env:

| Env variable | Purpose |
|--------------|--------|
| `AMAZON_SPAPI_AWS_ACCESS_KEY_ID` | AWS access key for SP-API signing |
| `AMAZON_SPAPI_AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AMAZON_SPAPI_AWS_SESSION_TOKEN` | Optional, for temporary credentials |

Without these, any SP-API call (orders pull, inventory, etc.) will fail with an error like *"Amazon SP-API AWS credentials are not configured"*.

---

## 2. What UnieConnect does with SP-API

| Capability | Backend route / trigger | SP-API used | Notes |
|------------|-------------------------|-------------|--------|
| **Orders pull** | `POST /api/v1/channel-accounts/:id/refresh` or cron every 30 min | `GET /orders/v0/orders`, `GET /orders/v0/orders/:id/orderItems` | Last 3 months on first connection, 2 days on subsequent; paginated |
| **Products/catalog pull** | Same as above | `GET /fba/inventory/v1/summaries` | FBA catalog + inventory; paginated (180-day window) |
| **Inventory push** | `POST /api/v1/amazon/inventory` | `PATCH /listings/2021-08-01/items/{sellerId}/{sku}` | Updates fulfillment availability (quantity) per SKU |
| **Create fulfillment order** | `POST /api/v1/amazon/fulfillment` | Fulfillment Outbound API | Create MFO for an order |
| **Inbound – create plan** | `POST /api/v1/amazon/inbound/plan` | Inbound Shipments API | Create inbound plan |
| **Inbound – create shipment** | `POST /api/v1/amazon/inbound/shipment` | Inbound Shipments API | Create shipment in plan |
| **Inbound – get labels** | `GET /api/v1/amazon/inbound/:shipmentId/labels` | Inbound Shipments API | Get PDF/ZPL labels |
| **Shipping – get rates** | Used inside `POST /api/v1/amazon/shipping/shipments` | Amazon Shipping API | Get shipping rate options |
| **Shipping – create shipment** | `POST /api/v1/amazon/shipping/shipments` | Amazon Shipping API | Create shipment, get label |
| **Shipping – get label** | `GET /api/v1/amazon/shipping/labels/:shipmentId` | Amazon Shipping API | Fetch label by shipment ID |

All of the above require a connected Amazon channel account (LWA tokens) and valid AWS credentials for signing.

---

## 3. How to verify

### 3.1 Connection and account

- **Dashboard:** Log in → Integrations → Amazon should show **Connected** (and Seller ID if stored).
- **API:**  
  `GET /api/v1/channel-accounts` with `Authorization: Bearer <token>`  
  Response should include an account with `channel: "amazon"`, `status: "active"`, and `sellingPartnerId` / `marketplaceIds` if returned by Amazon.

### 3.2 Orders pull (simplest SP-API check)

- **Dashboard:** Open the Amazon integration and use **Refresh** (or equivalent). No error means the backend called SP-API orders and order items successfully.
- **API:**  
  `POST /api/v1/channel-accounts/:accountId/refresh`  
  with `Authorization: Bearer <token>`.  
  Replace `:accountId` with the Amazon channel account id from step 3.1.  
  - 200 and logs like `amazon refresh completed` → SP-API orders pull is working.  
  - 4xx/5xx or “AWS credentials are not configured” → fix env or IAM/SP-API setup.

### 3.3 Inventory push

- **API:**  
  `POST /api/v1/amazon/inventory`  
  Body: `{ "accountId": "<channel-account-id>", "updates": [ { "sku": "<your-sku>", "quantity": 5 } ] }`  
  Use a real SKU that exists in the connected seller account. Success means the Listings API PATCH is working.

### 3.4 Fulfillment / Inbound / Shipping

- Use the routes above with the required body/query params (see `amazon.routes.ts` and the service files). Success responses or expected errors (e.g. invalid address) confirm the corresponding SP-API area is reachable.

---

## 4. Quick verification checklist

1. **LWA (auth)** – Amazon shows Connected in the app; `GET /api/v1/channel-accounts` returns the Amazon account.
2. **Env** – `AMAZON_SPAPI_AWS_ACCESS_KEY_ID` and `AMAZON_SPAPI_AWS_SECRET_ACCESS_KEY` are set (and IAM has SP-API permissions).
3. **Orders** – `POST /api/v1/channel-accounts/:id/refresh` returns 200 and backend logs show no SP-API error.
4. **Inventory** – `POST /api/v1/amazon/inventory` with a valid `accountId` and SKU returns success (or a clear API error from Amazon).
5. **Other APIs** – Call fulfillment / inbound / shipping routes as needed; interpret responses per Amazon’s docs.

---

## 5. Amazon SP-API references

- [SP-API Overview](https://developer-docs.amazon.com/sp-api/docs)
- [Orders API](https://developer-docs.amazon.com/sp-api/docs/orders-api-v0-reference)
- [Listings Items API](https://developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-reference)
- [Fulfillment Outbound](https://developer-docs.amazon.com/sp-api/docs/fulfillment-outbound-api-v2020-07-01-reference)
- [Inbound Shipments](https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api-v0-reference)
- [Amazon Shipping](https://developer-docs.amazon.com/amazon-shipping/docs) (if used)

Checking backend logs after each action (refresh, inventory, etc.) is the most reliable way to confirm what SP-API calls ran and whether they succeeded or failed.
