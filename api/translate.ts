/**
 * POST /api/translate { strings: string[], lang }
 * Translates deal texts (titles, criteria, AI reviews) into another language with Nemotron.
 */
import { handler, HttpError, MODELS, nemotronJson } from './_lib.js';

export default handler(async (body) => {
  const lang = typeof body.lang === 'string' ? body.lang : 'English';
  const strings = (Array.isArray(body.strings) ? body.strings : []).map((s) => String(s ?? '').slice(0, 1500)).slice(0, 200);
  if (!strings.length) throw new HttpError(400, 'Nothing to translate');
  const out: string[] = [];
  for (let i = 0; i < strings.length; i += 40) {
    const chunk = strings.slice(i, i + 40);
    const r = await nemotronJson<{ t: string[] }>(
      MODELS.text,
      [
        {
          role: 'system',
          content:
            `Translate each string into ${lang}. Keep money amounts, URLs, IDs, code, brand and product names unchanged. ` +
            `If a string is already in ${lang}, return it as is. Reply with ONLY JSON {"t":[...]} — the same number of strings, same order.`,
        },
        { role: 'user', content: JSON.stringify(chunk) },
      ],
      { maxTokens: 8000, think: 'off' },
    );
    const tr = Array.isArray(r.t) && r.t.length === chunk.length ? r.t : chunk;
    out.push(...tr.map((x, k) => (typeof x === 'string' && x.trim() ? x : chunk[k])));
  }
  return { strings: out };
});
