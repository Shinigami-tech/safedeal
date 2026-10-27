/**
 * POST /api/plan { brief, budget, currency, deadline?, lang? }
 * Nemotron turns a vague job description into milestones with checkable acceptance criteria.
 */
import { handler, HttpError, MODELS, nemotronJson, today } from './_lib.js';
import type { Plan } from './_types.js';

const SCHEMA = `{
  "title": "short project name",
  "summary": "1-2 sentences: what will be delivered",
  "currency": "ISO code",
  "milestones": [
    { "title": "milestone name", "amount": 0, "due": "YYYY-MM-DD or null",
      "criteria": [ { "text": "one concrete, verifiable acceptance criterion", "check": "page | image | manual" } ] }
  ],
  "risks": ["vague points in the brief that could cause a dispute, phrased as a question to agree on"]
}`;

export default handler(async (body) => {
  const brief = typeof body.brief === 'string' ? body.brief.trim().slice(0, 4000) : '';
  const budget = Number(body.budget) || 0;
  const currency = typeof body.currency === 'string' ? body.currency : 'USD';
  const deadline = typeof body.deadline === 'string' ? body.deadline : '';
  const lang = typeof body.lang === 'string' ? body.lang : 'English';
  if (brief.length < 10) throw new HttpError(400, 'Describe the job in a sentence or two');
  if (budget <= 0) throw new HttpError(400, 'Set a budget');

  const p = await nemotronJson<Plan>(MODELS.text, [
    {
      role: 'system',
      content:
        `You are SafeDeal, a fair escrow assistant between a client and a freelancer. Today is ${today()}. ` +
        `Split the job into 1-3 milestones whose amounts add up EXACTLY to the budget (${budget} ${currency}). ` +
        `Each milestone gets 3-5 acceptance criteria that a reviewer can objectively check — avoid taste words like "beautiful" or "modern". Criteria must cover ONLY what the brief asks for — never add requirements the client did not mention (extra fields, descriptions, languages, currencies, specific placements). Put open questions into "risks" instead. ` +
        `Use check "page" when it can be verified by opening the delivered website/link (texts, sections, forms, links, mobile layout), ` +
        `"image" when a screenshot is needed (design, visuals), "manual" only for things like source files or access handover. ` +
        `A "page" criterion must be verifiable just by reading the page's HTML/CSS (texts, sections, links, form fields, viewport meta, responsive CSS) — never performance, load times, console errors, browsers or analytics. ` +
        `Spread due dates before the deadline${deadline ? ` (${deadline})` : ''}. Write all texts in ${lang}. Reply with ONLY JSON:\n${SCHEMA}`,
    },
    { role: 'user', content: `JOB BRIEF:\n${brief}\n\nBUDGET: ${budget} ${currency}${deadline ? `\nDEADLINE: ${deadline}` : ''}` },
  ]);

  // make amounts add up to the budget exactly
  const ms = (Array.isArray(p.milestones) ? p.milestones : []).slice(0, 3).filter((m) => m && m.title);
  if (!ms.length) throw new HttpError(502, 'Could not plan milestones, try describing the job differently');
  const sum = ms.reduce((s, m) => s + (Number(m.amount) || 0), 0) || 1;
  let left = budget;
  ms.forEach((m, i) => {
    m.amount = i === ms.length - 1 ? Math.round(left * 100) / 100 : Math.round(((Number(m.amount) || 0) / sum) * budget * 100) / 100;
    left -= m.amount;
    m.criteria = (Array.isArray(m.criteria) ? m.criteria : [])
      .filter((c) => c && c.text)
      .slice(0, 5)
      .map((c) => ({ text: c.text, check: (['page', 'image', 'manual'].includes(c.check) ? c.check : 'page') as 'page' | 'image' | 'manual' }));
  });
  return { plan: { title: p.title || 'Project', summary: p.summary || '', currency, milestones: ms, risks: (p.risks || []).slice(0, 4) } satisfies Plan };
});
