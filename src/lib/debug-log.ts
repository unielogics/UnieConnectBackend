import fs from 'fs';
import path from 'path';

const LOG_PATH = path.join(process.cwd(), '..', '..', '.cursor', 'debug.log');

export function debugLog(message: string, data: Record<string, unknown>, hypothesisId?: string) {
  const payload = { ts: Date.now(), message, ...data, ...(hypothesisId && { hypothesisId }) };
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(payload) + '\n');
  } catch {}
}
