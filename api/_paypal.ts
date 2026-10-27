/**
 * PayPal REST (sandbox by default). Escrow = an Order with intent AUTHORIZE:
 * the client's money is reserved ("held") on approval, captured to the freelancer on release,
 * or voided (returned) on cancel. Keys live only on the server.
 */
import { HttpError } from './_lib.js';

export const PP_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

let cached: { token: string; until: number } | null = null;

async function token() {
  if (cached && cached.until > Date.now()) return cached.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new HttpError(500, 'Server is missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET');
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new HttpError(502, `PayPal auth failed (${res.status})`);
  const d = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: d.access_token, until: Date.now() + (d.expires_in - 60) * 1000 };
  return d.access_token;
}

/** Call the PayPal REST API; throws a readable error on failure. */
export async function pp<T = Record<string, unknown>>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
  const res = await fetch(`${PP_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
      ...(requestId ? { 'paypal-request-id': requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const d = data as { message?: string; details?: { issue?: string; description?: string }[]; name?: string };
    const why = d.details?.[0]?.description || d.details?.[0]?.issue || d.message || d.name || text.slice(0, 200);
    throw new HttpError(res.status === 422 || res.status === 400 ? 400 : 502, `PayPal: ${why}`);
  }
  return data as T;
}

export const money = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
