/**
 * POST /api/order { title, amount, currency, dealId, index, payee? }
 * Creates a PayPal order with intent AUTHORIZE — the client's money will be HELD, not paid out yet.
 */
import { handler, HttpError } from './_lib.js';
import { money, pp } from './_paypal.js';

export default handler(async (body) => {
  const amount = Number(body.amount);
  const currency = typeof body.currency === 'string' ? body.currency : 'USD';
  const title = String(body.title || 'Milestone').slice(0, 120);
  const ref = `${String(body.dealId || 'deal').slice(0, 40)}-${Number(body.index) || 0}`;
  const payee = typeof body.payee === 'string' && /@/.test(body.payee) ? body.payee.trim() : '';
  if (!(amount > 0)) throw new HttpError(400, 'Amount must be positive');
  const order = await pp<{ id: string; status: string }>(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: ref,
          custom_id: ref,
          description: `SafeDeal escrow: ${title}`.slice(0, 127),
          amount: { currency_code: currency, value: money(amount) },
          ...(payee ? { payee: { email_address: payee } } : {}),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: { brand_name: 'SafeDeal', user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING' },
        },
      },
    },
    `order-${ref}-${Date.now()}`,
  );
  return { id: order.id, status: order.status };
});
