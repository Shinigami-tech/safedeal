# SafeDeal — pay only for work that's actually done

**AI escrow for freelancers, built on PayPal.** The client's money is *held* by PayPal before work starts, an AI reviewer checks the delivered work against criteria both sides agreed on, and the money is released only when it matches. The client always has the final say.

> Built for the PayPal AI Hackathon 2026. Runs in the PayPal **sandbox** — no real money moves.

## The problem
Freelancers get "I'll pay next week" and never see the money. Clients pay up front and get half-finished work. Both sides argue about what "done" meant. Platforms that solve this take 10–20% fees and are not available everywhere.

## How it works
1. **Describe the job** in plain words + budget. **AI (NVIDIA Nemotron)** splits it into milestones with *objective, checkable* acceptance criteria — and flags vague points to agree on first.
2. **Client funds a milestone** with PayPal. SafeDeal creates an **Orders v2 order with `intent: AUTHORIZE`** — the money is **reserved, not paid**.
3. **Freelancer delivers** a link (and optionally a screenshot).
4. **AI reviewer** opens the link, reads the real page (HTML structure, forms, links, CSS, viewport) and checks every criterion **with quoted evidence**. Vision model looks at screenshots. The verdict is computed from the checks: any failed check ⇒ *changes needed*.
5. **Client decides:** **release** → PayPal **captures** the authorization and the money goes to the freelancer; **request changes** → the freelancer gets the AI's fix list and resubmits; **cancel** → PayPal **voids** the hold and nothing is charged.
6. Every step is logged; one click downloads an **evidence record** (criteria, submissions, AI reviews, PayPal IDs) ready for a PayPal dispute.

Try both sides in one browser with the **Client / Freelancer** switch. The built-in demo deliveries (`/demo/bean-there-v1.html` unfinished, `/demo/bean-there-v2.html` finished) show a full reject → fix → approve → release loop.

## PayPal integration
| Step | API |
| --- | --- |
| OAuth | `POST /v1/oauth2/token` (client credentials, cached) |
| Hold money | JS SDK Buttons (`intent=authorize`) + `POST /v2/checkout/orders` (`intent: AUTHORIZE`, optional `payee.email_address` = freelancer) |
| Confirm hold | `POST /v2/checkout/orders/{id}/authorize` → authorization id + expiry |
| Release | `POST /v2/payments/authorizations/{id}/capture` (`final_capture: true`) |
| Cancel | `POST /v2/payments/authorizations/{id}/void` |

All calls use `PayPal-Request-Id` for idempotency. Secrets stay on the server (Vercel functions); the browser only gets the public client id.

## AI
- **Planner** — `nvidia/nemotron-3-super-120b-a12b` on **Nebius Token Factory**: milestones, amounts that add up exactly, criteria limited to what the brief asks for.
- **Reviewer** — same model for pages, `nvidia/Nemotron-3.5-Super-VL` when a screenshot is attached. It sees a simplified DOM (tags + meaningful attributes, inline handlers, CSS) so it can verify forms, links, tables, `target=_blank`, viewport and media queries — and must quote evidence.
- Deterministic verdict on top of the model's checks; `[manual]` criteria (e.g. source handover) are left for the client and never block release.
- Retries with backoff when the inference API is busy.

## Run locally
```bash
npm install
cp .env.example .env    # PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (sandbox), NEBIUS_API_KEY
npm run dev             # http://localhost:5173
```
Set `ALLOW_PRIVATE_REVIEW=1` in `.env` to let the reviewer open `localhost` demo pages during development.

To fund a milestone, log in with a **sandbox personal account** from *developer.paypal.com → Testing Tools → Sandbox Accounts*.

## Deploy
Import the repo on Vercel and add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `NEBIUS_API_KEY` as environment variables.

## Limits & next steps
Deals are stored in the browser for the demo (both roles in one browser); next: shared deals with links for each side, PayPal **Subscriptions** for monthly retainers that pause automatically when the AI finds no work was done, **Payouts** for multi-freelancer teams, and filing disputes via the Disputes API with the evidence record attached.

MIT licensed.
