import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import { config } from '../config/env';
import { getCortexCredentialHeaders } from './cortex-credentials.service';

// ─── Resilience layer ──────────────────────────────────────────────────────
// Every call to Cortex goes through retryWithBackoff + circuit breaker.
// Timeouts are conservative; circuit short-circuits when Cortex is degraded
// so the caller falls back to local heuristics fast instead of queueing.

const CONNECT_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [250, 1_000, 4_000] as const;

type CortexPostOptions = {
  userId?: string | null;
  idempotencyKey?: string;
  extraHeaders?: Record<string, string>;
  allowGlobalApiKey?: boolean;
};

function deriveCortexUserId(payload: any, options?: CortexPostOptions): string | null {
  return String(
    options?.userId ||
      payload?.userId ||
      payload?.user_id ||
      payload?.tenant_id ||
      payload?.tenantId ||
      ''
  ).trim() || null;
}

// Circuit breaker state (per-process, not per-tenant; tenancy is in the
// payload, not in connection identity).
const breaker = {
  failures: 0,
  openedAt: 0,
  state: 'closed' as 'closed' | 'open' | 'half_open',
  threshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

function breakerRecordSuccess() {
  breaker.failures = 0;
  breaker.state = 'closed';
  breaker.openedAt = 0;
}

function breakerRecordFailure() {
  breaker.failures += 1;
  if (breaker.failures >= breaker.threshold && breaker.state !== 'open') {
    breaker.state = 'open';
    breaker.openedAt = Date.now();
  }
}

function breakerShouldShortCircuit(): boolean {
  if (breaker.state === 'open') {
    if (Date.now() - breaker.openedAt > breaker.cooldownMs) {
      breaker.state = 'half_open';
      return false; // let one request through
    }
    return true;
  }
  return false;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(err: any): boolean {
  const code = err?.code || err?.cause?.code || '';
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    String(err?.message || '').toLowerCase().includes('timeout')
  );
}

async function fetchWithTimeout(url: string, init: any): Promise<{ res: any; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const res: any = await fetch(url, { ...init, signal: controller.signal, timeout: CONNECT_TIMEOUT_MS });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── postCortex (resilient) ───────────────────────────────────────────────

export async function postCortex(path: string, payload: any, options: CortexPostOptions = {}) {
  const userId = deriveCortexUserId(payload, options);
  const credentialHeaders = userId
    ? await getCortexCredentialHeaders(userId).catch(() => null)
    : null;

  if (!credentialHeaders && (!options.allowGlobalApiKey || !config.cortex.apiKey)) {
    return {
      ok: false,
      status: 503,
      data: {
        error: 'No active tenant Cortex credential is configured on UnieConnect',
        path,
        userId,
      },
    };
  }

  if (breakerShouldShortCircuit()) {
    return {
      ok: false,
      status: 503,
      data: {
        error: 'Cortex circuit breaker open',
        circuit_open: true,
        retry_after_ms: Math.max(0, breaker.cooldownMs - (Date.now() - breaker.openedAt)),
        path,
      },
    };
  }

  // Idempotency-Key persists across retries so Cortex can dedupe.
  const idempotencyKey = options.idempotencyKey || `unieconnect-${randomUUID()}`;
  const url = `${config.cortex.apiUrl}${path}`;
  const authHeaders = credentialHeaders || { 'X-API-Key': config.cortex.apiKey };
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders,
    ...(options.extraHeaders || {}),
    'Idempotency-Key': idempotencyKey,
  };
  const body = JSON.stringify(payload);

  let lastErr: any = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const { res, text } = await fetchWithTimeout(url, { method: 'POST', headers, body });
      let data: any = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!res.ok && isRetryableStatus(res.status)) {
        breakerRecordFailure();
        lastErr = { status: res.status, data };
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
          continue;
        }
        return { ok: false, status: res.status, data, attempts: attempt + 1, idempotency_key: idempotencyKey };
      }
      // 2xx OR non-retryable 4xx — return as-is and reset breaker
      if (res.ok) breakerRecordSuccess();
      return { ok: res.ok, status: res.status, data, attempts: attempt + 1, idempotency_key: idempotencyKey };
    } catch (err: any) {
      lastErr = err;
      const code = err?.code || err?.cause?.code;
      const retryable = isRetryableError(err) || err?.name === 'AbortError';
      if (!retryable || attempt >= MAX_ATTEMPTS - 1) {
        breakerRecordFailure();
        return {
          ok: false,
          status: 503,
          data: { error: err?.message || 'Cortex call failed', code, attempts: attempt + 1, idempotency_key: idempotencyKey },
        };
      }
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
    }
  }

  // Should be unreachable; safety net.
  breakerRecordFailure();
  return { ok: false, status: 503, data: { error: 'Cortex retry budget exhausted', detail: String(lastErr?.message || lastErr), idempotency_key: idempotencyKey } };
}

export function cortexConfigStatus() {
  return {
    configured: Boolean(config.cortex.apiKey),
    cortexApiUrl: config.cortex.apiUrl,
    breaker: {
      state: breaker.state,
      failures: breaker.failures,
      opened_at: breaker.openedAt || null,
    },
  };
}
