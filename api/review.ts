/**
 * POST /api/review { milestone, submission: { url, notes, image? }, lang? }
 * The AI reviewer: opens the delivered link, reads the page (and an optional screenshot with Nemotron vision),
 * and checks every acceptance criterion with evidence. It recommends — the client still decides.
 */
import { handler, HttpError, MODELS, Msg, nemotronJson } from './_lib.js';
import type { Milestone, Review } from './_types.js';

interface Page {
  url: string;
  status: number;
  title: string;
  mobile: boolean;
  forms: number;
  inputs: string[];
  images: number;
  links: string[];
  headings: string[];
  text: string;
  /** cleaned HTML of the body: tags + the attributes that matter for review */
  structure: string;
  css: string;
}

const KEEP = /^(href|target|type|name|placeholder|alt|aria-label|required|id|lang|for|value|title|role|on[a-z]+)$/i;

/** Strip scripts/styles/classes; keep tags, text and meaningful attributes so the model sees real structure. */
function simplify(html: string) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<([a-z0-9]+)((?:\s+[^\s=>]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/gi, (_m, tag: string, attrs: string, slash: string) => {
      const kept = Array.from(attrs.matchAll(/([^\s=>]+)(?:=("[^"]*"|'[^']*'|[^\s>]+))?/g))
        .filter((a) => KEEP.test(a[1]))
        .map((a) => {
          let v = (a[2] ?? '').replace(/^["']|["']$/g, '');
          if (v.startsWith('data:')) v = 'data:…';
          return v ? `${a[1]}="${v.slice(0, /^on/i.test(a[1]) ? 200 : 80)}"` : a[1];
        });
      return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}${slash}>`;
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14000);
}

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1\]?|metadata)/i;

function strip(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readPage(raw: string): Promise<Page | null> {
  let u: URL;
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || (PRIVATE.test(u.hostname) && process.env.ALLOW_PRIVATE_REVIEW !== '1')) throw new HttpError(400, 'Only public http(s) links can be reviewed');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'SafeDealReviewer/1.0 (+escrow review bot)' } });
    const html = (await res.text()).slice(0, 1_500_000);
    const pick = (re: RegExp) => Array.from(html.matchAll(re), (m) => strip(m[1]).slice(0, 140)).filter(Boolean);
    return {
      url: res.url || u.toString(),
      status: res.status,
      title: strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''),
      mobile: /<meta[^>]+name=["']viewport["'][^>]*width=device-width/i.test(html),
      forms: (html.match(/<form[\s>]/gi) || []).length,
      inputs: Array.from(html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi), (m) => {
        const a = m[2];
        const g = (k: string) => a.match(new RegExp(`${k}=["']([^"']*)`, 'i'))?.[1] ?? '';
        return [m[1], g('type'), g('name') || g('placeholder') || g('aria-label')].filter(Boolean).join(':');
      }).slice(0, 30),
      images: (html.match(/<img[\s>]/gi) || []).length,
      links: Array.from(html.matchAll(/<a\b([^>]*)href=["']([^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi), (m) => `${strip(m[4]).slice(0, 40)} → ${m[2].slice(0, 80)}${/target=["']_blank/i.test(m[1] + m[3]) ? ' (new tab)' : ''}`).slice(0, 40),
      headings: pick(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi).slice(0, 25),
      text: strip(html).slice(0, 4000),
      structure: simplify(html),
      css: Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi), (m) => m[1]).join('\n').replace(/\s+/g, ' ').slice(0, 3000),
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return { url: u.toString(), status: 0, title: '', mobile: false, forms: 0, inputs: [], images: 0, links: [], headings: [], text: `(could not open the link: ${(e as Error).message})`, structure: '', css: '' };
  } finally {
    clearTimeout(timer);
  }
}

const SCHEMA = `{
  "verdict": "approve | changes | reject",
  "score": 0,
  "summary": "2 sentences for the client: is the milestone done?",
  "checks": [ { "criterion": "copy of the criterion", "status": "pass | fail | unclear", "evidence": "what exactly you saw (quote text, count forms, etc.)" } ],
  "fixes": ["concrete things the freelancer must fix; empty if none"]
}`;

export default handler(async (body) => {
  const m = body.milestone as Milestone | undefined;
  const sub = body.submission as { url?: string; notes?: string; image?: string; images?: string[] } | undefined;
  const lang = typeof body.lang === 'string' ? body.lang : 'English';
  /** checks confirmed in earlier submissions of this milestone — proven once, they stay proven */
  const earlier = (Array.isArray(body.earlier) ? body.earlier : []) as { criterion: string; evidence: string }[];
  if (!m?.criteria?.length) throw new HttpError(400, 'Milestone with criteria required');
  if (!sub?.url && !sub?.image && !sub?.images?.length) throw new HttpError(400, 'Submit a link or a screenshot');

  const page = sub.url ? await readPage(sub.url) : null;
  const shots = [...(Array.isArray(sub.images) ? sub.images : []), ...(sub.image ? [sub.image] : [])]
    .filter((x) => typeof x === 'string' && x.startsWith('data:image/'))
    .slice(0, 3);
  const image = shots.length > 0;

  // games, 3D/WebXR apps and SPAs draw their content with JavaScript: the raw HTML is nearly empty
  const spa = !!page && page.status > 0 && page.status < 400 && page.text.split(' ').length < 60;
  const facts = page
    ? `DELIVERED PAGE (fetched just now)\nURL: ${page.url}\nHTTP status: ${page.status}\nTitle: ${page.title}\nMobile viewport meta: ${page.mobile ? 'yes' : 'no'}\n${spa ? 'NOTE: this page is rendered by JavaScript — the HTML below may not contain the real content.\n' : ''}` +
      `Forms: ${page.forms}\nForm fields: ${page.inputs.join(', ') || 'none'}\nImages: ${page.images}\nHeadings: ${page.headings.join(' | ')}\n` +
      `Links: ${page.links.join(' | ')}\nVisible text: ${page.text}\n\nPAGE HTML (simplified, inline handlers kept):\n${page.structure}\n\nCSS:\n${page.css || '(none)'}`
    : 'No link was provided.';

  const content: Msg['content'] = [
    {
      type: 'text',
      text:
        `MILESTONE: ${m.title} (${m.amount})\nACCEPTANCE CRITERIA:\n${m.criteria.map((c, i) => `${i + 1}. [${c.check}] ${c.text}`).join('\n')}\n\n` +
        `FREELANCER'S NOTE: ${sub.notes || '(none)'}\n\n${facts}${image ? `\n\n${shots.length} screenshot(s) of the delivered work are attached. A screenshot shows only one moment: if something is simply not visible in it, mark "unclear", not "fail" — use "fail" only when the screenshots show it is wrong or missing where it should be.` : ''}\n\nWrite summary, evidence and fixes in ${lang}.`,
    },
    ...shots.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];

  const r = await nemotronJson<Review>(image ? MODELS.vision : MODELS.text, [
    {
      role: 'system',
      content:
        `You are an impartial escrow reviewer. Money is held until the work matches the agreed acceptance criteria. ` +
        `Judge ONLY against the criteria, using ONLY the evidence given (page facts, screenshot, note). Be strict but fair: ` +
        `judge the MEANING a client cares about, not the literal implementation — a section that clearly serves as the About section passes even without id="about"; a contact form with equivalent fields passes; similar wording passes unless the criterion demands exact text in quotes. ` +
        `If the page looks rendered by JavaScript (little visible text, an empty root element), mark content criteria "unclear" (not "fail") and say a screenshot is needed. ` +
        `"pass" needs clear evidence, "fail" when evidence shows it is missing or wrong, "unclear" when it cannot be verified from the evidence ` +
        `(e.g. [manual] criteria, or a JavaScript-only page with no visible text). Never invent what you did not see. ` +
        `verdict: "approve" if every checkable criterion passes; "changes" if some fail but the work is mostly there; "reject" if the link is broken or the work is clearly not done. ` +
        `score = 0-100 share of criteria met. Reply with ONLY JSON:\n${SCHEMA}`,
    },
    { role: 'user', content },
  ]);

  const raw = Array.isArray(r.checks) ? r.checks : [];
  const checks = raw.map((c) => ({
    criterion: c.criterion,
    status: (['pass', 'fail', 'unclear'].includes(c.status) ? c.status : 'unclear') as 'pass' | 'fail' | 'unclear',
    evidence: c.evidence || '',
  }));
  // Verdict is computed from the checks, not trusted blindly: [manual] criteria are for the client to confirm
  // and never block a release; anything checkable that FAILS does.
  const kinds = checks.map((c, i) => (checks.length === m.criteria.length ? m.criteria[i].check : m.criteria.find((k) => k.text === c.criterion)?.check ?? 'page'));
  checks.forEach((c, i) => {
    if (kinds[i] === 'manual' && c.status === 'unclear') c.evidence = `Client confirms this one. ${c.evidence}`.trim();
    // an empty HTML shell is not proof that the work is missing — it just can't be seen without running it
    if (spa && !image && c.status === 'fail') {
      c.status = 'unclear';
      c.evidence = `This page is drawn by JavaScript (a game/3D app or single-page app), so the reviewer cannot see it from the HTML. Attach a screenshot or the client test-plays it. (${c.evidence})`;
    }
  });
  checks.forEach((c, i) => {
    if (c.status !== 'unclear') return;
    const crit = checks.length === m.criteria.length ? m.criteria[i].text : c.criterion;
    const prev = earlier.find((e) => e.criterion === crit || e.criterion === c.criterion);
    if (prev) {
      c.status = 'pass';
      c.evidence = `Confirmed in an earlier submission: ${prev.evidence}`;
    }
  });
  const auto = checks.filter((_, i) => kinds[i] !== 'manual');
  const passed = auto.filter((c) => c.status === 'pass').length;
  const failed = auto.filter((c) => c.status === 'fail').length;
  const broken = page ? page.status === 0 || page.status >= 400 : false;
  const unclear = auto.length - passed - failed;
  const verdict: Review['verdict'] = broken || (failed > 0 && passed === 0) ? 'reject' : failed || unclear ? 'changes' : 'approve';
  const review: Review = {
    verdict,
    score: auto.length ? Math.round((passed / auto.length) * 100) : Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
    summary: spa && !image && verdict !== 'approve' ? 'This delivery is drawn by JavaScript (a game, 3D or single-page app), so the AI cannot see it from the page code alone. Attach a screenshot so the AI can check it visually, or the client test-plays it and decides.' : r.summary || '',
    checks,
    fixes: Array.isArray(r.fixes) ? r.fixes.slice(0, 6) : [],
    counts: { checkable: auto.length, confirmed: passed, client: checks.length - auto.length },
    observed: page ? { url: page.url, title: page.title, status: page.status, mobile: page.mobile, forms: page.forms, images: page.images, words: page.text.split(' ').length } : null,
  };
  return { review };
});
