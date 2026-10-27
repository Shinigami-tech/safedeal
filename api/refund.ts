/**
 * POST /api/refund { authorizationId }
 * Deal cancelled before release → void the hold; the client's money is never taken.
 */
import { handler, HttpError } from './_lib.js';
import { pp } from './_paypal.js';

export default handler(async (body) => {
  const id = String(body.authorizationId || '');
  if (!/^[A-Z0-9]{8,40}$/.test(id)) throw new HttpError(400, 'Bad authorization id');
  await pp('POST', `/v2/payments/authorizations/${id}/void`, undefined, `void-${id}`);
  const a = await pp<{ status: string }>('GET', `/v2/payments/authorizations/${id}`);
  return { status: a.status };
});
