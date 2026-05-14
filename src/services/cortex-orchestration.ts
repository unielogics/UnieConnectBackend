import fetch from 'node-fetch';
import { config } from '../config/env';

export async function postCortex(path: string, payload: any) {
  if (!config.cortex.apiKey) {
    return {
      ok: false,
      status: 503,
      data: {
        error: 'CORTEX_API_KEY is not configured on UnieConnect',
        path,
      },
    };
  }
  const res = await fetch(`${config.cortex.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.cortex.apiKey,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

export function cortexConfigStatus() {
  return {
    configured: Boolean(config.cortex.apiKey),
    cortexApiUrl: config.cortex.apiUrl,
  };
}
