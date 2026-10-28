import './styles.css';
import type { Plan, Review } from '../api/_types';
import { dealFromPlan, loadDeals, loadRole, saveDeals, saveRole, type Deal, type DealMilestone, type Role } from './store';

/* ------------------------------------------------------------------ state */

let deals = loadDeals();
let role: Role = loadRole();
const busy: Record<string, boolean> = {};
let flash = '';
let cfg: { paypalClientId: string; sandbox: boolean } | null = null;
let ppLoading: Promise<void> | null = null;
let confirmCancel = '';

const SAMPLE = {
  brief:
    'Landing page for a coffee shop in Astana called "Bean There". Needs: a menu with prices, opening hours, a table-booking form (name, phone, date, time, guests), a link to Instagram, and it must work well on phones.',
  budget: 300,
  deadline: (() => {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    return d.toISOString().slice(0, 10);
  })(),
};

const app = document.getElementById('app')!;

/* ---------------------------------------------------------------- helpers */

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usd = (v: number, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(v);
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (iso: string | null | undefined) =>
  iso ? new Date(iso.length <= 10 ? iso + 'T12:00:00' : iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

async function api<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Server error (${res.status})`);
  }
  if (!res.ok) throw new Error((data as { error?: string }).error || `Server error (${res.status})`);
  return data as T;
}

function toast(msg: string) {
  flash = msg;
  render();
  setTimeout(() => {
    if (flash === msg) {
      flash = '';
      render();
    }
  }, 3600);
}

const persist = () => saveDeals(deals);
const route = () => location.hash.replace(/^#\/?/, '');
const go = (r: string) => (location.hash = '#/' + r);
const currentDeal = () => {
  const m = route().match(/^deal\/(.+)$/);
  return m ? deals.find((d) => d.id === m[1]) ?? null : null;
};
const log = (d: Deal, who: Deal['log'][number]['who'], text: string) => d.log.push({ at: Date.now(), who, text });

const totals = (d: Deal) => {
  const t = { total: 0, held: 0, released: 0, returned: 0 };
  for (const m of d.milestones) {
    t.total += m.amount;
    if (m.state === 'released') t.released += m.amount;
    else if (m.state === 'returned') t.returned += m.amount;
    else if (m.state !== 'draft') t.held += m.amount;
  }
  return t;
};

/* --------------------------------------------------------------- PayPal JS */

declare global {
  interface Window {
    paypal?: {
      Buttons: (o: Record<string, unknown>) => { render: (el: HTMLElement) => Promise<void>; isEligible: () => boolean };
    };
  }
}

async function loadPayPal(currency: string) {
  if (window.paypal) return;
  if (!ppLoading) {
    ppLoading = (async () => {
      cfg ??= await api<{ paypalClientId: string; sandbox: boolean }>('config', {});
      if (!cfg.paypalClientId) throw new Error('PayPal is not configured on the server');
      await new Promise<void>((ok, fail) => {
        const s = document.createElement('script');
        s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg!.paypalClientId)}&intent=authorize&currency=${currency}&components=buttons&disable-funding=paylater,venmo`;
        s.onload = () => ok();
        s.onerror = () => fail(new Error('Could not load PayPal'));
        document.head.appendChild(s);
      });
    })();
  }
  await ppLoading;
}

/** Mount PayPal buttons for every unfunded milestone shown to the client. */
async function mountButtons(d: Deal) {
  const slots = Array.from(document.querySelectorAll<HTMLElement>('[data-pp]'));
  if (!slots.length) return;
  try {
    await loadPayPal(d.plan.currency);
  } catch (e) {
    slots.forEach((s) => (s.innerHTML = `<p class="err">${esc((e as Error).message)}</p>`));
    return;
  }
  for (const slot of slots) {
    if (!slot.isConnected || slot.dataset.mounted) continue;
    slot.dataset.mounted = '1';
    const i = Number(slot.dataset.pp);
    const m = d.milestones[i];
    window.paypal!
      .Buttons({
        style: { layout: 'horizontal', color: 'gold', shape: 'pill', label: 'paypal', height: 44, tagline: false },
        createOrder: async () => {
          const r = await api<{ id: string }>('order', { title: `${d.plan.title} — ${m.title}`, amount: m.amount, currency: d.plan.currency, dealId: d.id, index: i, payee: d.payee });
          m.pay.orderId = r.id;
          persist();
          return r.id;
        },
        onApprove: async (data: { orderID: string }) => {
          busy['hold' + i] = true;
          render();
          try {
            const r = await api<{ authorizationId: string; heldUntil: string | null; payer: string }>('authorize', { orderId: data.orderID });
            m.pay = { ...m.pay, authorizationId: r.authorizationId, heldUntil: r.heldUntil ?? undefined, payer: r.payer };
            m.state = 'held';
            log(d, 'paypal', `${usd(m.amount, d.plan.currency)} held for "${m.title}" (authorization ${r.authorizationId})`);
            persist();
            toast(`${usd(m.amount, d.plan.currency)} is now held by PayPal. The freelancer can start.`);
          } catch (e) {
            toast(`PayPal: ${(e as Error).message}`);
          }
          busy['hold' + i] = false;
          render();
        },
        onError: (err: unknown) => toast(`PayPal error: ${String((err as Error)?.message ?? err).slice(0, 120)}`),
      })
      .render(slot)
      .then(() => slot.querySelector('.muted')?.remove())
      .catch(() => {});
  }
}

/* ---------------------------------------------------------------- actions */

async function createDeal(form: HTMLFormElement) {
  const fd = new FormData(form);
  const brief = String(fd.get('brief') || '').trim();
  const budget = Number(fd.get('budget'));
  const deadline = String(fd.get('deadline') || '');
  const payee = String(fd.get('payee') || '').trim();
  busy.plan = true;
  render();
  try {
    const { plan } = await api<{ plan: Plan }>('plan', { brief, budget, currency: 'USD', deadline });
    const d = dealFromPlan(plan, brief, payee);
    log(d, 'client', `Created the deal for ${usd(budget)}`);
    deals.unshift(d);
    persist();
    busy.plan = false;
    go('deal/' + d.id);
  } catch (e) {
    busy.plan = false;
    toast(`Couldn't plan it: ${(e as Error).message}`);
  }
}

async function fileToDataUrl(file: File) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

async function submitWork(d: Deal, i: number, form: HTMLFormElement) {
  const m = d.milestones[i];
  const fd = new FormData(form);
  const url = String(fd.get('url') || '').trim();
  const notes = String(fd.get('notes') || '').trim();
  const file = fd.get('shot') as File | null;
  const image = file && file.size ? await fileToDataUrl(file) : undefined;
  if (!url && !image) return toast('Add a link to the work or a screenshot');
  m.submissions.push({ url, notes, image, at: Date.now() });
  m.state = 'submitted';
  log(d, 'freelancer', `Submitted "${m.title}"${url ? `: ${url}` : ''}`);
  persist();
  render();
  await review(d, i);
}

async function review(d: Deal, i: number) {
  const m = d.milestones[i];
  const sub = m.submissions[m.submissions.length - 1];
  busy['rev' + i] = true;
  render();
  try {
    const { review } = await api<{ review: Review }>('review', { milestone: m, submission: sub });
    m.reviews.push(review);
    m.state = 'reviewed';
    const label = { approve: 'recommends release', changes: 'asks for changes', reject: 'recommends rejecting' }[review.verdict];
    log(d, 'ai', `Reviewed "${m.title}": ${review.score}% of criteria met — ${label}`);
    persist();
  } catch (e) {
    m.state = 'submitted';
    toast(`Review failed: ${(e as Error).message}`);
  }
  busy['rev' + i] = false;
  render();
}

async function release(d: Deal, i: number) {
  const m = d.milestones[i];
  if (!m.pay.authorizationId) return;
  busy['rel' + i] = true;
  render();
  try {
    const r = await api<{ captureId: string; status: string }>('release', { authorizationId: m.pay.authorizationId });
    m.pay.captureId = r.captureId;
    m.state = 'released';
    log(d, 'client', `Accepted "${m.title}"`);
    log(d, 'paypal', `${usd(m.amount, d.plan.currency)} released to the freelancer (capture ${r.captureId})`);
    persist();
    toast(`Paid! ${usd(m.amount, d.plan.currency)} sent to the freelancer.`);
  } catch (e) {
    toast(`Couldn't release: ${(e as Error).message}`);
  }
  busy['rel' + i] = false;
  render();
}

async function cancelHold(d: Deal, i: number) {
  const m = d.milestones[i];
  if (!m.pay.authorizationId) return;
  busy['ref' + i] = true;
  render();
  try {
    await api('refund', { authorizationId: m.pay.authorizationId });
    m.state = 'returned';
    log(d, 'paypal', `Hold voided — ${usd(m.amount, d.plan.currency)} stays with the client`);
    persist();
  } catch (e) {
    toast(`Couldn't cancel: ${(e as Error).message}`);
  }
  busy['ref' + i] = false;
  confirmCancel = '';
  render();
}

function requestChanges(d: Deal, i: number) {
  const m = d.milestones[i];
  const r = m.reviews[m.reviews.length - 1];
  m.state = 'held';
  log(d, 'client', `Requested changes on "${m.title}"${r?.fixes.length ? `: ${r.fixes.join('; ')}` : ''}`);
  persist();
  render();
  toast('Sent back to the freelancer with the AI’s fix list.');
}

async function pdf(kind: 'agreement' | 'evidence' | 'receipt', d: Deal, i = 0) {
  busy['pdf' + kind + i] = true;
  render();
  try {
    const m = await import('./pdf');
    const bytes = kind === 'agreement' ? await m.agreementPdf(d) : kind === 'evidence' ? await m.evidencePdf(d) : await m.receiptPdf(d, i);
    toast(`PDF downloaded (${Math.max(1, Math.round(bytes / 1024))} KB)`);
  } catch (e) {
    toast(`Couldn't make the PDF: ${(e as Error).message}`);
  }
  busy['pdf' + kind + i] = false;
  render();
}

function sign(d: Deal, form: HTMLFormElement) {
  const name = String(new FormData(form).get('signname') || '').trim();
  if (name.length < 3) return toast('Type your full name to sign');
  d.signatures = { ...d.signatures, [role]: { name, at: Date.now() } };
  log(d, role, `${name} signed the agreement as ${role}`);
  persist();
  render();
  toast(bothSigned(d) ? 'Both sides signed — the client can now fund the first milestone.' : 'Signed. Waiting for the other side.');
}

/** Changing the terms after one side signed invalidates that signature — both must agree to the same text. */
function criteriaChanged(d: Deal, text: string) {
  log(d, role, text);
  if (d.signatures?.client || d.signatures?.freelancer) {
    d.signatures = {};
    log(d, 'ai', 'Terms changed — signatures cleared, both sides sign again');
    toast('Terms changed, so both sides need to sign again.');
  }
  persist();
  render();
}

const bothSigned = (d: Deal) => !!(d.signatures?.client && d.signatures?.freelancer);

/** Old plain-text record (kept for reference; the UI uses the PDF version). */
function evidence(d: Deal) {
  const lines = [
    `SafeDeal evidence record — ${d.plan.title}`,
    `Deal ${d.id}, created ${new Date(d.created).toISOString()}`,
    '',
    'AGREED BRIEF',
    d.brief,
    '',
    ...d.milestones.flatMap((m, i) => [
      `MILESTONE ${i + 1}: ${m.title} — ${usd(m.amount, d.plan.currency)} — state: ${m.state}`,
      ...m.criteria.map((c) => `  • ${c.text}`),
      ...(m.pay.authorizationId ? [`  PayPal authorization: ${m.pay.authorizationId}${m.pay.captureId ? `, capture: ${m.pay.captureId}` : ''}`] : []),
      ...m.submissions.map((s, k) => `  Submission ${k + 1} (${new Date(s.at).toISOString()}): ${s.url} ${s.notes ? `— ${s.notes}` : ''}`),
      ...m.reviews.map((r, k) => `  AI review ${k + 1}: ${r.verdict}, ${r.score}% — ${r.summary}\n${r.checks.map((c) => `    [${c.status}] ${c.criterion} — ${c.evidence}`).join('\n')}`),
      '',
    ]),
    'TIMELINE',
    ...d.log.map((e) => `${new Date(e.at).toISOString()}  ${e.who.toUpperCase().padEnd(10)} ${e.text}`),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `safedeal-${d.id}-evidence.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------------------------------------------------------- views */

function header() {
  const r = route();
  return `
  <header class="top">
    <a class="brand" href="#/"><img src="/favicon.svg" alt="" /><span>SafeDeal</span></a>
    <nav>
      <a href="#/" class="${r === '' ? 'on' : ''}">Deals</a>
      <div class="roles" role="tablist" aria-label="View as">
        <button data-act="role" data-r="client" class="${role === 'client' ? 'on' : ''}">👤 Client</button>
        <button data-act="role" data-r="freelancer" class="${role === 'freelancer' ? 'on' : ''}">🛠 Freelancer</button>
      </div>
    </nav>
  </header>`;
}

function homeView() {
  return `
  <main class="home">
    <section class="hero">
      <p class="eyebrow">AI escrow for freelancers · powered by PayPal</p>
      <h1>Pay only for work<br/><em>that's actually done.</em></h1>
      <p class="lede">Describe the job. AI turns it into milestones with clear acceptance criteria. The client's money is held by PayPal, an AI reviewer checks the delivered work against the criteria, and the money is released only when it matches.</p>
    </section>

    <section class="flow">
      <div><b>1</b><span>Describe the job</span></div><i>→</i>
      <div><b>2</b><span>Money held by PayPal</span></div><i>→</i>
      <div><b>3</b><span>AI checks the work</span></div><i>→</i>
      <div><b>4</b><span>Released to freelancer</span></div>
    </section>

    <form class="card new" data-form="new">
      <div class="card-h"><h3>New deal</h3><button type="button" class="link" data-act="sample">Use the coffee-shop example</button></div>
      <label>What needs to be done?
        <textarea name="brief" rows="4" required minlength="10" placeholder="e.g. A landing page for my bakery with a menu, prices, opening hours and an order form. Must work on phones."></textarea>
      </label>
      <div class="row3">
        <label>Budget (USD)<input name="budget" type="number" min="1" step="1" required placeholder="300" /></label>
        <label>Deadline<input name="deadline" type="date" /></label>
        <label>Freelancer's PayPal email <span class="muted small">(optional)</span><input name="payee" type="email" placeholder="freelancer@example.com" /></label>
      </div>
      <button class="btn primary big" ${busy.plan ? 'disabled' : ''}>${busy.plan ? '<span class="spin"></span> AI is planning milestones…' : '✨ Plan the deal with AI'}</button>
    </form>

    ${
      deals.length
        ? `<section class="list"><h3>Your deals</h3>${deals
            .map((d) => {
              const t = totals(d);
              const done = d.milestones.filter((m) => m.state === 'released').length;
              const next = d.milestones.find((m) => !['released', 'returned'].includes(m.state));
              return `<a class="deal-row" href="#/deal/${d.id}">
                <div><b>${esc(d.plan.title)}</b><span class="muted small">${done}/${d.milestones.length} milestones paid${next ? ` · next: ${esc(next.title)}` : ''}</span></div>
                <div class="nums"><span class="pill held">${usd(t.held)} held</span><span class="pill paid">${usd(t.released)} paid</span></div>
              </a>`;
            })
            .join('')}</section>`
        : ''
    }

    <section class="why">
      <div><h4>For freelancers</h4><p>No more "I'll pay next week". The money is already reserved before you start.</p></div>
      <div><h4>For clients</h4><p>Nothing is paid until the work passes the checks you agreed on — and you always have the final say.</p></div>
      <div><h4>For disputes</h4><p>Every step is logged with AI evidence, ready for a PayPal dispute if it ever comes to that.</p></div>
    </section>
  </main>`;
}

const STEPS: { key: DealMilestone['state'][]; label: string }[] = [
  { key: ['draft'], label: 'Agreed' },
  { key: ['held'], label: 'Money held' },
  { key: ['submitted'], label: 'Delivered' },
  { key: ['reviewed'], label: 'AI checked' },
  { key: ['released', 'returned'], label: 'Paid' },
];

function stepper(m: DealMilestone) {
  const idx = STEPS.findIndex((s) => s.key.includes(m.state));
  return `<ol class="stepper">${STEPS.map(
    (s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''} ${m.state === 'returned' && i === 4 ? 'void' : ''}"><span></span>${i === 4 && m.state === 'returned' ? 'Returned' : s.label}</li>`,
  ).join('')}</ol>`;
}

function reviewBlock(r: Review) {
  const icon = { pass: '✓', fail: '✕', unclear: '?' } as const;
  const label = { approve: 'Ready to release', changes: 'Changes needed', reject: 'Not delivered' }[r.verdict];
  return `<div class="review ${r.verdict}">
    <div class="rv-h">
      <div class="ring" style="--p:${r.score}"><span>${r.score}%</span></div>
      <div><span class="tag ${r.verdict}">${label}</span><p>${esc(r.summary)}</p>
      ${r.observed ? `<p class="muted small">Opened <a href="${esc(r.observed.url)}" target="_blank" rel="noopener">${esc(r.observed.title || r.observed.url)}</a> · HTTP ${r.observed.status} · ${r.observed.forms} form${r.observed.forms === 1 ? '' : 's'} · ${r.observed.images} images · ${r.observed.mobile ? 'mobile-ready' : 'no mobile viewport'}</p>` : ''}</div>
    </div>
    <ul class="checks">${r.checks
      .map((c) => `<li class="${c.status}"><span class="ck">${icon[c.status]}</span><div><b>${esc(c.criterion)}</b><p>${esc(c.evidence)}</p></div></li>`)
      .join('')}</ul>
    ${r.fixes.length ? `<div class="fixes"><b>To fix:</b><ul>${r.fixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
  </div>`;
}

function milestoneCard(d: Deal, m: DealMilestone, i: number) {
  const cur = d.plan.currency;
  const last = m.reviews[m.reviews.length - 1];
  const sub = m.submissions[m.submissions.length - 1];
  let action = '';

  if (m.state === 'draft' && !bothSigned(d)) {
    action = `<div class="act wait">✍️ Both sides sign the agreement above before money is held.</div>`;
  } else if (m.state === 'draft') {
    action =
      role === 'client'
        ? `<div class="act"><p><b>Fund this milestone.</b> ${usd(m.amount, cur)} will be <b>held</b> by PayPal — not paid — until you accept the work.</p>
           ${busy['hold' + i] ? '<p><span class="spin"></span> Holding the money…</p>' : `<div class="pp" data-pp="${i}"><span class="muted small">Loading PayPal…</span></div>`}
           <p class="muted small">Sandbox: log in with a PayPal sandbox <b>personal</b> test account.</p></div>`
        : `<div class="act wait">⏳ Waiting for the client to put ${usd(m.amount, cur)} on hold. Don't start before it's held.</div>`;
  } else if (m.state === 'held') {
    const fixes = last && last.fixes.length ? `<div class="fixes"><b>Client asked for changes:</b><ul>${last.fixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '';
    action =
      role === 'freelancer'
        ? `${fixes}<form class="act submit" data-form="submit" data-i="${i}">
            <p><b>💰 ${usd(m.amount, cur)} is held for you.</b> Deliver the work and the AI will check it against the criteria.</p>
            <label>Link to the work<input name="url" placeholder="https://your-delivery.com" value="${esc(sub?.url ?? '')}" /></label>
            <div class="demo-links">Demo delivery: <button type="button" class="link" data-act="demo" data-v="1" data-i="${i}">v1 (unfinished)</button> · <button type="button" class="link" data-act="demo" data-v="2" data-i="${i}">v2 (finished)</button></div>
            <label>Note for the client<input name="notes" placeholder="What did you do?" /></label>
            <label>Screenshot <span class="muted small">(optional — the AI looks at it too)</span><input name="shot" type="file" accept="image/*" /></label>
            <button class="btn primary">Submit for review</button>
          </form>`
        : `${fixes}<div class="act wait">💰 <b>${usd(m.amount, cur)} held by PayPal</b>${m.pay.heldUntil ? ` until ${day(m.pay.heldUntil)}` : ''}. The freelancer is working on it.
            <div class="row-btns"><button class="btn small ghost" data-act="cancel" data-i="${i}">${confirmCancel === d.id + i ? 'Sure? Return the money' : 'Cancel & return money'}</button></div></div>`;
  } else if (m.state === 'submitted') {
    action = `<div class="act wait">${busy['rev' + i] ? '<span class="spin"></span> <b>AI reviewer is opening the delivery and checking every criterion…</b>' : `Delivered. <button class="btn small" data-act="review" data-i="${i}">Run AI review</button>`}</div>`;
  } else if (m.state === 'reviewed' && last) {
    action = `${reviewBlock(last)}
      ${
        role === 'client'
          ? `<div class="row-btns">
              <button class="btn ${last.verdict === 'approve' ? 'primary' : ''}" data-act="release" data-i="${i}" ${busy['rel' + i] ? 'disabled' : ''}>${busy['rel' + i] ? 'Releasing…' : `✓ Accept & release ${usd(m.amount, cur)}`}</button>
              <button class="btn ${last.verdict === 'approve' ? '' : 'primary'}" data-act="changes" data-i="${i}">↺ Request changes</button>
              <button class="btn ghost" data-act="cancel" data-i="${i}">${confirmCancel === d.id + i ? 'Sure? Return the money' : 'Cancel & return money'}</button>
            </div>
            ${last.verdict !== 'approve' ? '<p class="muted small">The AI recommends changes, but you decide.</p>' : ''}`
          : `<div class="act wait">The client is deciding. ${last.verdict === 'approve' ? 'The AI recommends releasing the money.' : 'You will see the fix list if changes are requested.'}</div>`
      }`;
  } else if (m.state === 'released') {
    action = `<div class="act ok">✓ <b>${usd(m.amount, cur)} paid to the freelancer</b> via PayPal${m.pay.captureId ? ` · <span class="mono">${esc(m.pay.captureId)}</span>` : ''}
      <div class="row-btns"><button class="btn small" data-act="pdf" data-k="receipt" data-i="${i}">${busy['pdfreceipt' + i] ? 'Making PDF…' : '⬇ Receipt (PDF)'}</button></div></div>`;
  } else if (m.state === 'returned') {
    action = `<div class="act void">↩ Hold cancelled — ${usd(m.amount, cur)} was never taken from the client.</div>`;
  }

  const results = last ? new Map(last.checks.map((c) => [c.criterion, c.status])) : null;
  const editable = m.state === 'draft' && !bothSigned(d);
  return `
  <article class="card ms ${m.state}">
    <div class="ms-h">
      <div><span class="muted small">Milestone ${i + 1}${m.due ? ` · due ${day(m.due)}` : ''}</span><h3>${esc(m.title)}</h3></div>
      <div class="amt">${usd(m.amount, cur)}</div>
    </div>
    ${stepper(m)}
    <div class="crit"><h4>Acceptance criteria${editable ? ' <span class="muted small">— edit before signing</span>' : ''}</h4><ul>${m.criteria
      .map((c, k) => {
        const st = results?.get(c.text);
        return `<li class="${st ?? ''}"><span class="kind" title="checked via ${c.check}">${c.check === 'page' ? '🔗' : c.check === 'image' ? '🖼' : '✋'}</span><span class="ct">${esc(c.text)}</span>${
          editable ? `<button class="x" data-act="crit-del" data-i="${i}" data-c="${k}" title="Remove">✕</button>` : ''
        }</li>`;
      })
      .join('')}</ul>${
      editable
        ? `<form class="crit-add" data-form="crit-add" data-i="${i}"><input name="crit" placeholder="Add a criterion, e.g. “There is a contact form with name, email and message”" /><button class="btn small">+ Add</button></form>`
        : ''
    }</div>
    ${action}
  </article>`;
}

function agreementCard(d: Deal) {
  const sig = d.signatures ?? {};
  const mine = sig[role];
  const row = (who: Role, label: string) => {
    const x = sig[who];
    return `<div class="sig ${x ? 'done' : ''}"><span class="muted small">${label}</span>${x ? `<b class="sig-name">${esc(x.name)}</b><span class="muted small">signed ${new Date(x.at).toLocaleString()}</span>` : '<span class="muted">Not signed yet</span>'}</div>`;
  };
  return `<section class="card agreement">
    <div class="card-h"><h3>📄 Deal agreement</h3><button class="btn small" data-act="pdf" data-k="agreement">${busy.pdfagreement0 ? 'Making PDF…' : '⬇ Agreement (PDF)'}</button></div>
    <p class="muted small">Scope, milestones, acceptance criteria and payment rules. Both sides sign before any money is held.</p>
    <div class="sigs">${row('client', '👤 Client')}${row('freelancer', '🛠 Freelancer')}</div>
    ${
      mine
        ? ''
        : `<form class="sign" data-form="sign"><input name="signname" placeholder="Type your full name to sign as ${role}" autocomplete="name" />
           <button class="btn primary">✍️ I agree & sign</button></form>`
    }
  </section>`;
}

function dealView(d: Deal) {
  const t = totals(d);
  const who = { client: '👤', freelancer: '🛠', ai: '✨', paypal: '🅿️' } as const;
  return `
  <main class="deal">
    <a class="back" href="#/">← All deals</a>
    <div class="deal-h">
      <div><h1>${esc(d.plan.title)}</h1><p class="lede">${esc(d.plan.summary)}</p></div>
      <div class="money">
        <div><span>Total</span><b>${usd(t.total, d.plan.currency)}</b></div>
        <div class="held"><span>Held by PayPal</span><b>${usd(t.held, d.plan.currency)}</b></div>
        <div class="paid"><span>Paid out</span><b>${usd(t.released, d.plan.currency)}</b></div>
      </div>
    </div>
    <div class="viewing">Viewing as <b>${role === 'client' ? '👤 Client' : '🛠 Freelancer'}</b> — switch roles at the top to see the other side.</div>

    ${agreementCard(d)}

    ${d.plan.risks.length ? `<section class="card risks"><h3>⚠ Agree on these before you start</h3><ul>${d.plan.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>` : ''}

    ${d.milestones.map((m, i) => milestoneCard(d, m, i)).join('')}

    <section class="card log">
      <div class="card-h"><h3>Timeline</h3><button class="btn small ghost" data-act="pdf" data-k="evidence">${busy.pdfevidence0 ? 'Making PDF…' : '⬇ Evidence record (PDF)'}</button></div>
      <ul>${[...d.log]
        .reverse()
        .map((e) => `<li><span class="who">${who[e.who]}</span><div><p>${esc(e.text)}</p><span class="muted small">${when(e.at)}</span></div></li>`)
        .join('')}</ul>
    </section>
    <p class="disclaimer">PayPal sandbox demo — no real money moves. The AI recommends; the client always makes the final decision.</p>
  </main>`;
}

function footer() {
  return `<footer class="foot">SafeDeal · payments by <b>PayPal</b> (Orders v2 authorize → capture / void) · AI review by <b>NVIDIA Nemotron</b> · open source (MIT)</footer>`;
}

/* ---------------------------------------------------------------- render */

function render() {
  const d = currentDeal();
  const drafts: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('form input:not([type=file]), form textarea').forEach((el) => {
    if (el.name) drafts[(el.form?.dataset.form ?? '') + (el.form?.dataset.i ?? '') + el.name] = el.value;
  });
  app.innerHTML = `${header()}${d ? dealView(d) : homeView()}${footer()}${flash ? `<div class="toast">${esc(flash)}</div>` : ''}`;
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('form input:not([type=file]), form textarea').forEach((el) => {
    const k = (el.form?.dataset.form ?? '') + (el.form?.dataset.i ?? '') + el.name;
    if (k in drafts && drafts[k]) el.value = drafts[k];
  });
  if (d && role === 'client') mountButtons(d);
}

app.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!t) return;
  const d = currentDeal();
  const i = Number(t.dataset.i);
  switch (t.dataset.act) {
    case 'role':
      role = t.dataset.r === 'freelancer' ? 'freelancer' : 'client';
      saveRole(role);
      render();
      break;
    case 'sample': {
      const f = document.querySelector<HTMLFormElement>('form[data-form=new]')!;
      (f.elements.namedItem('brief') as HTMLTextAreaElement).value = SAMPLE.brief;
      (f.elements.namedItem('budget') as HTMLInputElement).value = String(SAMPLE.budget);
      (f.elements.namedItem('deadline') as HTMLInputElement).value = SAMPLE.deadline;
      break;
    }
    case 'demo': {
      const f = t.closest('form') as HTMLFormElement;
      (f.elements.namedItem('url') as HTMLInputElement).value = `${location.origin}/demo/bean-there-v${t.dataset.v}.html`;
      (f.elements.namedItem('notes') as HTMLInputElement).value = t.dataset.v === '1' ? 'First version of the page, please check' : 'Fixed everything from the review';
      break;
    }
    case 'review':
      if (d) review(d, i);
      break;
    case 'release':
      if (d) release(d, i);
      break;
    case 'changes':
      if (d) requestChanges(d, i);
      break;
    case 'cancel':
      if (!d) break;
      if (confirmCancel === d.id + i) cancelHold(d, i);
      else {
        confirmCancel = d.id + i;
        render();
        setTimeout(() => {
          if (confirmCancel === d.id + i) {
            confirmCancel = '';
            render();
          }
        }, 3500);
      }
      break;
    case 'evidence':
      if (d) evidence(d);
      break;
    case 'crit-del':
      if (d) {
        const m = d.milestones[i];
        const [gone] = m.criteria.splice(Number(t.dataset.c), 1);
        criteriaChanged(d, `Removed criterion from "${m.title}": ${gone?.text ?? ''}`);
      }
      break;
    case 'pdf':
      if (d) pdf(t.dataset.k as 'agreement' | 'evidence' | 'receipt', d, Number(t.dataset.i) || 0);
      break;
  }
});

app.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  if (f.dataset.form === 'new') createDeal(f);
  if (f.dataset.form === 'crit-add') {
    const d = currentDeal();
    const text = String(new FormData(f).get('crit') || '').trim();
    if (d && text.length > 5) {
      const m = d.milestones[Number(f.dataset.i)];
      m.criteria.push({ text, check: 'page' });
      (f.elements.namedItem('crit') as HTMLInputElement).value = '';
      criteriaChanged(d, `Added criterion to "${m.title}": ${text}`);
    }
  }
  if (f.dataset.form === 'sign') {
    const d = currentDeal();
    if (d) sign(d, f);
  }
  if (f.dataset.form === 'submit') {
    const d = currentDeal();
    if (d) submitWork(d, Number(f.dataset.i), f);
  }
});

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});

render();
