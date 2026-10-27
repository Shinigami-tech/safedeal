/**
 * POST /api/authorize { orderId }
 * After the client approves in the PayPal popup: reserve the money (authorization = escrow hold).
 */
import { handler, HttpError } from './_lib.js';
import { pp } from './_paypal.js';

interface AuthResp {
  id: string;
  status: string;
  payer?: { email_address?: string; name?: { given_name?: string } };
  purchase_units: { payments?: { authorizations?: { id: string; status: string; expiration_time?: string }[] } }[];
}

export default handler(async (body) => {
  const orderId = String(body.orderId || '');
  if (!/^[A-Z0-9]{8,40}$/.test(orderId)) throw new HttpError(400, 'Bad order id');
  const r = await pp<AuthResp>('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
  const a = r.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!a) throw new HttpError(502, 'PayPal did not return an authorization');
  return { authorizationId: a.id, status: a.status, heldUntil: a.expiration_time ?? null, payer: r.payer?.email_address ?? '' };
});
