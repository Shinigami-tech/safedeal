/**
 * POST /api/release { authorizationId }
 * Client accepts the work → capture the held money; it goes to the freelancer (payee).
 */
import { handler, HttpError } from './_lib.js';
import { pp } from './_paypal.js';

export default handler(async (body) => {
  const id = String(body.authorizationId || '');
  if (!/^[A-Z0-9]{8,40}$/.test(id)) throw new HttpError(400, 'Bad authorization id');
  const c = await pp<{ id: string; status: string }>(
    'POST',
    `/v2/payments/authorizations/${id}/capture`,
    { final_capture: true, note_to_payer: 'Released by SafeDeal after the work was accepted' },
    `cap-${id}`,
  );
  return { captureId: c.id, status: c.status };
});
