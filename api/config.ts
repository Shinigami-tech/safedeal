/** POST /api/config → public settings for the browser (PayPal client id is public by design). */
import { handler } from './_lib.js';
import { PP_BASE } from './_paypal.js';

export default handler(async () => ({
  paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  sandbox: PP_BASE.includes('sandbox'),
}));
