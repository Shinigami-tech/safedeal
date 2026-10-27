/**
 * PDF documents generated in the browser (no server, nothing uploaded):
 *  - Deal agreement with both parties' e-signatures
 *  - Evidence record (for a PayPal dispute)
 *  - Payment receipt for a released milestone
 * Uses pdf-lib + a subset of DejaVu Sans (Latin, Cyrillic, ₸ ₽ € …), so files stay small (~20–40 KB).
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Deal } from './store';

const INK = rgb(0.043, 0.122, 0.09);
const MUTED = rgb(0.42, 0.48, 0.45);
const GREEN = rgb(0.043, 0.239, 0.18);
const LINE = rgb(0.86, 0.83, 0.76);
const A4: [number, number] = [595.28, 841.89];
const M = 56; // page margin

let fontBytes: Promise<[ArrayBuffer, ArrayBuffer]> | null = null;
const loadFonts = () =>
  (fontBytes ??= Promise.all([fetch('/fonts/DejaVuSans.ttf').then((r) => r.arrayBuffer()), fetch('/fonts/DejaVuSans-Bold.ttf').then((r) => r.arrayBuffer())]));

const money = (v: number, cur: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(v);
const stamp = (t: number | string) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateOnly = (iso: string | null | undefined) => (iso ? new Date(iso.length <= 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  private chars: Set<number>;
  constructor(
    public doc: PDFDocument,
    public font: PDFFont,
    public bold: PDFFont,
    public footer: string,
  ) {
    this.chars = new Set(font.getCharacterSet());
    this.newPage();
  }
  /** replace characters the font cannot draw (emoji etc.) */
  clean(s: string) {
    return Array.from(String(s ?? '').replace(/\s+/g, ' ')).map((ch) => (this.chars.has(ch.codePointAt(0)!) ? ch : ch.trim() ? '' : ' ')).join('');
  }
  newPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - M;
  }
  need(h: number) {
    if (this.y - h < M + 30) this.newPage();
  }
  wrap(text: string, size: number, width: number, f = this.font) {
    const words = this.clean(text).split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(t, size) > width && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }
  text(s: string, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {}) {
    const size = o.size ?? 10.5;
    const f = o.bold ? this.bold : this.font;
    const x = o.x ?? M;
    const lh = size * 1.42;
    for (const l of this.wrap(s, size, o.width ?? A4[0] - x - M, f)) {
      this.need(lh);
      this.page.drawText(l, { x, y: this.y - size, size, font: f, color: o.color ?? INK });
      this.y -= lh;
    }
    this.y -= o.gap ?? 4;
  }
  title(s: string, sub?: string) {
    this.page.drawRectangle({ x: 0, y: A4[1] - 8, width: A4[0], height: 8, color: GREEN });
    this.text('SafeDeal', { size: 10, bold: true, color: GREEN, gap: 10 });
    this.text(s, { size: 22, bold: true, gap: 4 });
    if (sub) this.text(sub, { size: 10, color: MUTED, gap: 12 });
  }
  h(s: string) {
    this.need(40);
    this.y -= 8;
    this.text(s.toUpperCase(), { size: 9.5, bold: true, color: GREEN, gap: 2 });
    this.rule();
  }
  rule() {
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4[0] - M, y: this.y }, thickness: 0.7, color: LINE });
    this.y -= 10;
  }
  kv(rows: [string, string][]) {
    for (const [k, v] of rows) {
      const lines = this.wrap(v, 10.5, A4[0] - M - 170 - M);
      this.need(lines.length * 15);
      this.page.drawText(this.clean(k), { x: M, y: this.y - 10.5, size: 9.5, font: this.font, color: MUTED });
      lines.forEach((l, i) => this.page.drawText(l, { x: M + 170, y: this.y - 10.5 - i * 15, size: 10.5, font: this.font, color: INK }));
      this.y -= lines.length * 15 + 3;
    }
    this.y -= 4;
  }
  bullet(s: string, mark = '•', x = M + 4) {
    const lines = this.wrap(s, 10.5, A4[0] - x - 14 - M);
    this.need(lines.length * 15);
    this.page.drawText(this.clean(mark), { x, y: this.y - 10.5, size: 10.5, font: this.bold, color: GREEN });
    lines.forEach((l, i) => this.page.drawText(l, { x: x + 14, y: this.y - 10.5 - i * 15, size: 10.5, font: this.font, color: INK }));
    this.y -= lines.length * 15 + 3;
  }
  signature(label: string, sig: { name: string; at: number } | undefined, x: number) {
    const w = (A4[0] - 2 * M - 30) / 2;
    const top = this.y;
    this.page.drawText(this.clean(label), { x, y: top - 10, size: 9.5, font: this.bold, color: MUTED });
    if (sig) {
      this.page.drawText(this.clean(sig.name), { x, y: top - 40, size: 17, font: this.bold, color: GREEN });
      this.page.drawText(this.clean(`Signed electronically · ${stamp(sig.at)}`), { x, y: top - 70, size: 8.5, font: this.font, color: MUTED });
    } else {
      this.page.drawText('Not signed yet', { x, y: top - 40, size: 11, font: this.font, color: MUTED });
    }
    this.page.drawLine({ start: { x, y: top - 50 }, end: { x: x + w, y: top - 50 }, thickness: 0.8, color: INK });
  }
  finish() {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      p.drawLine({ start: { x: M, y: M - 4 }, end: { x: A4[0] - M, y: M - 4 }, thickness: 0.5, color: LINE });
      p.drawText(this.clean(this.footer), { x: M, y: M - 18, size: 8, font: this.font, color: MUTED });
      const pg = `Page ${i + 1} of ${n}`;
      p.drawText(pg, { x: A4[0] - M - this.font.widthOfTextAtSize(pg, 8), y: M - 18, size: 8, font: this.font, color: MUTED });
    });
  }
}

async function writer(title: string, footer: string) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [r, b] = await loadFonts();
  const font = await doc.embedFont(r, { subset: true });
  const bold = await doc.embedFont(b, { subset: true });
  doc.setTitle(title);
  doc.setAuthor('SafeDeal');
  doc.setCreator('SafeDeal (safedeal demo)');
  doc.setProducer('pdf-lib');
  return new Writer(doc, font, bold, footer);
}

async function save(w: Writer, name: string) {
  w.finish();
  const bytes = await w.doc.save();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return bytes.length;
}

const party = (d: Deal, who: 'client' | 'freelancer') => d.signatures?.[who]?.name || (who === 'freelancer' && d.payee ? d.payee : '—');

/* --------------------------------------------------------------- documents */

export async function agreementPdf(d: Deal) {
  const cur = d.plan.currency;
  const total = d.milestones.reduce((s, m) => s + m.amount, 0);
  const w = await writer(`Deal agreement — ${d.plan.title}`, `SafeDeal agreement · deal ${d.id} · generated ${stamp(Date.now())}`);
  w.title('Deal agreement', `${d.plan.title} · Deal ${d.id} · created ${stamp(d.created)}`);

  w.h('Parties');
  w.kv([
    ['Client', party(d, 'client')],
    ['Freelancer', party(d, 'freelancer')],
    ...(d.payee ? ([['Freelancer PayPal', d.payee]] as [string, string][]) : []),
    ['Total price', `${money(total, cur)} in ${d.milestones.length} milestone${d.milestones.length > 1 ? 's' : ''}`],
  ]);

  w.h('Scope of work');
  w.text(d.plan.summary || d.brief, { gap: 6 });
  w.text(`Original brief: ${d.brief}`, { size: 9.5, color: MUTED, gap: 6 });

  w.h('Milestones and acceptance criteria');
  d.milestones.forEach((m, i) => {
    w.need(60);
    w.text(`${i + 1}. ${m.title} — ${money(m.amount, cur)} · due ${dateOnly(m.due)}`, { size: 11.5, bold: true, gap: 4 });
    m.criteria.forEach((c) => w.bullet(`${c.text}${c.check === 'manual' ? '  (confirmed by the client)' : ''}`, '✓', M + 8));
    w.y -= 6;
  });

  if (d.plan.risks.length) {
    w.h('Points to clarify');
    d.plan.risks.forEach((r) => w.bullet(r));
  }

  w.h('How payment works');
  [
    'Before work on a milestone starts, the client authorizes its amount with PayPal. The money is held (authorized), not paid.',
    'The freelancer delivers the milestone (a link and/or screenshot). An AI reviewer checks the delivery against the acceptance criteria above and records its evidence.',
    "The AI's review is a recommendation. The client makes the final decision: release the payment, request changes, or cancel.",
    'On release, PayPal captures the held amount and pays the freelancer. On cancellation, the hold is voided and the client is not charged.',
    'A PayPal hold is valid for a limited time (up to 29 days). If a milestone takes longer, the client re-authorizes it.',
    'Both parties agree that this record, the AI reviews and the PayPal transaction IDs may be used as evidence in a PayPal dispute.',
  ].forEach((t, i) => w.bullet(t, `${i + 1}.`));

  w.h('Signatures');
  w.need(100);
  const top = w.y;
  w.signature('CLIENT', d.signatures?.client, M);
  w.y = top;
  w.signature('FREELANCER', d.signatures?.freelancer, M + (A4[0] - 2 * M - 30) / 2 + 30);
  w.y = top - 90;
  w.text('Electronic signatures: each party typed their full name and confirmed "I agree" in SafeDeal. Created in the PayPal sandbox demo of SafeDeal — no real money is involved.', {
    size: 8.5,
    color: MUTED,
  });
  return save(w, `SafeDeal-agreement-${d.id}.pdf`);
}

export async function evidencePdf(d: Deal) {
  const cur = d.plan.currency;
  const w = await writer(`Evidence record — ${d.plan.title}`, `SafeDeal evidence record · deal ${d.id} · generated ${stamp(Date.now())}`);
  w.title('Evidence record', `${d.plan.title} · Deal ${d.id} · for a PayPal dispute or mediation`);
  w.h('Deal');
  w.kv([
    ['Client', party(d, 'client')],
    ['Freelancer', party(d, 'freelancer')],
    ['Created', stamp(d.created)],
    ['Agreement signed', d.signatures?.client && d.signatures?.freelancer ? `client ${stamp(d.signatures.client.at)}, freelancer ${stamp(d.signatures.freelancer.at)}` : 'not by both parties'],
  ]);
  w.text(`Brief: ${d.brief}`, { size: 9.5, color: MUTED, gap: 6 });

  d.milestones.forEach((m, i) => {
    w.h(`Milestone ${i + 1}: ${m.title}`);
    w.kv([
      ['Amount', money(m.amount, cur)],
      ['Status', m.state],
      ...(m.pay.authorizationId ? ([['PayPal authorization', m.pay.authorizationId]] as [string, string][]) : []),
      ...(m.pay.captureId ? ([['PayPal capture', m.pay.captureId]] as [string, string][]) : []),
    ]);
    w.text('Acceptance criteria', { bold: true, size: 10, gap: 2 });
    m.criteria.forEach((c) => w.bullet(c.text));
    m.submissions.forEach((s, k) => {
      w.text(`Submission ${k + 1} · ${stamp(s.at)}`, { bold: true, size: 10, gap: 2 });
      w.text(`${s.url || '(screenshot only)'}${s.notes ? ` — "${s.notes}"` : ''}`, { size: 10, gap: 6 });
    });
    m.reviews.forEach((r, k) => {
      w.text(`AI review ${k + 1}: ${r.verdict.toUpperCase()} · ${r.score}% of checkable criteria met`, { bold: true, size: 10, gap: 2 });
      w.text(r.summary, { size: 10, gap: 4 });
      r.checks.forEach((c) => w.bullet(`${c.criterion} — ${c.evidence}`, c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '?', M + 8));
      if (r.fixes.length) {
        w.text('Requested fixes:', { size: 10, bold: true, gap: 2 });
        r.fixes.forEach((f) => w.bullet(f, '–', M + 8));
      }
      w.y -= 4;
    });
  });

  w.h('Timeline');
  d.log.forEach((e) => w.bullet(`${stamp(e.at)} · ${e.who.toUpperCase()} · ${e.text}`, '·'));
  return save(w, `SafeDeal-evidence-${d.id}.pdf`);
}

export async function receiptPdf(d: Deal, i: number) {
  const m = d.milestones[i];
  const cur = d.plan.currency;
  const released = [...d.log].reverse().find((e) => e.who === 'paypal' && e.text.includes('released') && e.text.includes(m.title))?.at ?? Date.now();
  const w = await writer(`Payment receipt — ${m.title}`, `SafeDeal receipt · deal ${d.id} · milestone ${i + 1}`);
  w.title('Payment receipt', `${d.plan.title} · Milestone ${i + 1}`);
  w.y -= 6;
  w.text(money(m.amount, cur), { size: 30, bold: true, color: GREEN, gap: 2 });
  w.text(`Released to the freelancer on ${stamp(released)}`, { color: MUTED, gap: 12 });
  w.h('Details');
  w.kv([
    ['Milestone', m.title],
    ['Paid by', party(d, 'client')],
    ['Paid to', party(d, 'freelancer')],
    ['Payment method', 'PayPal (authorization captured)'],
    ['PayPal authorization', m.pay.authorizationId ?? '—'],
    ['PayPal capture ID', m.pay.captureId ?? '—'],
    ['AI review', m.reviews.length ? `${m.reviews[m.reviews.length - 1].verdict} · ${m.reviews[m.reviews.length - 1].score}%` : '—'],
  ]);
  w.h('Accepted work');
  m.criteria.forEach((c) => w.bullet(c.text, '✓'));
  const last = m.submissions[m.submissions.length - 1];
  if (last?.url) w.text(`Delivered at: ${last.url}`, { size: 10, color: MUTED });
  w.y -= 10;
  w.text('PayPal sandbox demo — no real money was moved.', { size: 8.5, color: MUTED });
  return save(w, `SafeDeal-receipt-${d.id}-${i + 1}.pdf`);
}
