import { createHash } from 'crypto';
import fetch from 'node-fetch';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

type AnyRow = Record<string, any>;

const trim = (value: unknown) => (value == null ? '' : String(value).trim());
const json = (value: unknown, fallback: any) => (value == null ? fallback : value);

function wmsExternalOmsObjectId(userId: string) {
  const normalized = trim(userId);
  if (/^[a-f0-9]{24}$/i.test(normalized)) return normalized.toLowerCase();
  return createHash('sha1').update(`unieconnect:app_user:${normalized}`).digest('hex').slice(0, 24);
}

function wmsBillingAddress(address: AnyRow | null | undefined) {
  const a = json(address, {}) || {};
  return {
    addressLine1: trim(a.addressLine1 || a.line1 || a.address1 || a.street || a.address),
    addressLine2: trim(a.addressLine2 || a.line2 || a.address2),
    city: trim(a.city),
    state: trim(a.state || a.stateOrProvinceCode || a.province),
    zipCode: trim(a.zipCode || a.postalCode || a.zip || a.postcode),
    country: trim(a.country || a.countryCode || 'US') || 'US',
  };
}

async function connectedWmsLinks(userId: string) {
  const res = await pgQuery<{
    warehouse_code: string | null;
    metadata: AnyRow | null;
  }>(
    `SELECT warehouse_code, metadata
     FROM oms_warehouse_links
     WHERE user_id = $1 AND status = 'connected'`,
    [userId],
  );
  return res?.rows || [];
}

export async function syncCurrentUserProfileToWms(userId: string, log?: any) {
  if (!config.wmsApiUrl || !config.internalApiKey) {
    return { skipped: true, reason: 'wms_internal_api_not_configured' };
  }

  const links = await connectedWmsLinks(userId).catch((err) => {
    log?.warn?.({ err, userId }, 'failed checking WMS profile sync links');
    return [];
  });
  if (links.length === 0) return { skipped: true, reason: 'no_connected_wms_link' };

  const res = await pgQuery<{
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    llc_name: string | null;
    billing_address: AnyRow | null;
  }>(
    `SELECT id, email, first_name, last_name, phone, llc_name, billing_address
     FROM app_users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  const user = res?.rows[0];
  if (!user) return { skipped: true, reason: 'user_not_found' };

  const linkedOmsIds = Array.from(
    new Set(
      links
        .map((link) => {
          const metadata = json(link.metadata, {}) || {};
          return trim(metadata.wmsOmsIntermediaryId || metadata.omsIntermediaryId || metadata.externalOmsIntermediaryId);
        })
        .filter(Boolean),
    ),
  );
  const externalOmsIntermediaryIds = linkedOmsIds.length > 0 ? linkedOmsIds : [wmsExternalOmsObjectId(userId)];

  const basePayload = {
    companyName:
      trim(user.llc_name) ||
      [trim(user.first_name), trim(user.last_name)].filter(Boolean).join(' ') ||
      trim(user.email).toLowerCase(),
    firstName: trim(user.first_name),
    lastName: trim(user.last_name),
    phone: trim(user.phone),
    email: trim(user.email).toLowerCase(),
    llcName: trim(user.llc_name),
    billingAddress: wmsBillingAddress(user.billing_address),
  };

  const responses = [];
  for (const externalOmsIntermediaryId of externalOmsIntermediaryIds) {
    const response = await fetch(`${config.wmsApiUrl}/api/v1/internal/oms/intermediary/sync-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': config.internalApiKey,
      },
      body: JSON.stringify({ externalOmsIntermediaryId, ...basePayload }),
    });
    const body = await response.json().catch(() => ({}));
    responses.push({ externalOmsIntermediaryId, status: response.status, body });
    if (!response.ok) {
      const err = new Error(String((body as AnyRow).message || (body as AnyRow).error || `WMS profile sync failed with ${response.status}`));
      (err as any).status = response.status;
      (err as any).payload = body;
      throw err;
    }
  }

  await pgQuery('INSERT INTO app_user_activity_log (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)', [
    userId,
    'wms_profile_sync_requested',
    JSON.stringify({
      externalOmsIntermediaryIds,
      response: responses,
    }),
  ]).catch((err) => log?.warn?.({ err, userId }, 'failed to log WMS profile sync'));

  return { success: true, response: responses };
}
