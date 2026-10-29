// External research for the AI agent, limited to official, SEBI-regulated sources.
//
// The agent may search and read pages only on the domains below: the regulator (SEBI), the
// industry body (AMFI), the RBI, the stock exchanges and depositories, and the websites of
// SEBI-registered mutual fund AMCs, plus the Income Tax Department for tax rules. Every URL is checked before it is fetched and again after
// redirects; anything else is refused. PDFs are converted to page text with pdf.js.
export const OFFICIAL_DOMAINS = {
  'sebi.gov.in': 'SEBI',
  'amfiindia.com': 'AMFI',
  'rbi.org.in': 'RBI',
  'nseindia.com': 'NSE',
  'bseindia.com': 'BSE',
  'nsdl.co.in': 'NSDL',
  'cdslindia.com': 'CDSL',
  'incometax.gov.in': 'Income Tax Department',
  // SEBI-registered mutual fund AMCs
  'ppfas.com': 'PPFAS Mutual Fund',
  'nipponindiaim.com': 'Nippon India Mutual Fund',
  'hdfcfund.com': 'HDFC Mutual Fund',
  'icicipruamc.com': 'ICICI Prudential Mutual Fund',
  'sbimf.com': 'SBI Mutual Fund',
  'kotakmf.com': 'Kotak Mutual Fund',
  'axismf.com': 'Axis Mutual Fund',
  'utimf.com': 'UTI Mutual Fund',
  'mutualfund.adityabirlacapital.com': 'Aditya Birla Sun Life Mutual Fund',
  'dspim.com': 'DSP Mutual Fund',
  'miraeassetmf.co.in': 'Mirae Asset Mutual Fund',
  'franklintempletonindia.com': 'Franklin Templeton Mutual Fund',
  'tatamutualfund.com': 'Tata Mutual Fund',
  'motilaloswalmf.com': 'Motilal Oswal Mutual Fund',
  'canararobeco.com': 'Canara Robeco Mutual Fund',
  'edelweissmf.com': 'Edelweiss Mutual Fund',
  'hsbcmf.co.in': 'HSBC Mutual Fund',
  'quantmutual.com': 'quant Mutual Fund',
  'bandhanmutual.com': 'Bandhan Mutual Fund',
  'invescomutualfund.com': 'Invesco Mutual Fund',
};

const MAX_CHARS = 8000;
const MAX_PDF_PAGES = 40;

let fetchImpl = (...a) => fetch(...a);
export const _setOfficialFetch = (f) => { fetchImpl = f; };

// Publisher name for an allowed URL, or null.
export function officialPublisher(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const match = Object.keys(OFFICIAL_DOMAINS).filter((d) => host === d || host.endsWith(`.${d}`)).sort((a, b) => b.length - a.length)[0];
  return match ? OFFICIAL_DOMAINS[match] : null;
}

const notAllowed = (url) => new Error(`${url} is not an official SEBI-regulated source. Allowed domains: ${Object.keys(OFFICIAL_DOMAINS).join(', ')}.`);

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", raquo: '»', laquo: '«', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', rupee: '₹' };
const decode = (s) => s.replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
// PDFs a page embeds or links to (SEBI circular pages show the circular itself in an iframe).
const pdfLinks = (html, base) => [...new Set([...html.matchAll(/(?:src|href|data)=["']([^"']+\.pdf[^"']*)["']/gi)]
  .map((m) => { try { return new URL(decode(m[1]).replace(/^.*?[?&]file=/, ''), base).href; } catch { return null; } })
  .filter((u) => u && officialPublisher(u)))].slice(0, 8);
const htmlText = (html) => decode(html
  .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<\/(p|div|li|tr|h\d|section|article|br)>|<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

async function pdfText(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const pages = [];
  for (let pn = 1; pn <= Math.min(pdf.numPages, MAX_PDF_PAGES); pn++) {
    const tc = await (await pdf.getPage(pn)).getTextContent();
    pages.push(`[page ${pn}] ${tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim()}`);
  }
  return { text: pages.join('\n'), note: pdf.numPages > MAX_PDF_PAGES ? `First ${MAX_PDF_PAGES} of ${pdf.numPages} pages.` : '' };
}

// Keep the lines around the words the agent is looking for, so long pages fit the budget.
function focus(text, find) {
  if (!find || text.length <= MAX_CHARS) return text.slice(0, MAX_CHARS);
  const terms = find.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const lines = text.split('\n');
  const keep = new Set();
  lines.forEach((l, i) => { if (terms.some((t) => l.toLowerCase().includes(t))) for (let j = i - 2; j <= i + 2; j++) keep.add(j); });
  const out = [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b).map((i) => lines[i]).join('\n');
  return (out || text).slice(0, MAX_CHARS);
}

// Fetch one official page or PDF and return its text.
export async function readOfficial(url, find = '') {
  const publisher = officialPublisher(url);
  if (!publisher) throw notAllowed(url);
  let r;
  try {
    r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Fin Advisor research agent)', Accept: 'text/html,application/pdf;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (e) { throw new Error(`Could not reach ${url} (${e.message}).`); }
  const finalUrl = r.url || url;
  if (!officialPublisher(finalUrl)) throw notAllowed(finalUrl);
  if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}.`);
  const type = r.headers?.get?.('content-type') ?? '';
  const buf = Buffer.from(await r.arrayBuffer());
  let text, note = '';
  if (/pdf/i.test(type) || buf.subarray(0, 5).toString() === '%PDF-') ({ text, note } = await pdfText(buf));
  else {
    const html = buf.toString('utf8');
    const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    const pdfs = pdfLinks(html, finalUrl);
    text = (title ? `Title: ${title}\n` : '') + (pdfs.length ? `PDF documents on this page (read them for the full text):\n${pdfs.join('\n')}\n` : '') + htmlText(html);
  }
  if (text.replace(/\s/g, '').length < 50) throw new Error(`No readable text at ${url} (it may be a scanned PDF or a page that needs a browser).`);
  return { url: finalUrl, publisher, text: focus(text, find), note };
}

// Web search restricted to the official domains (DuckDuckGo's HTML endpoint, no key needed).
export async function searchOfficial(query, site = '') {
  const sites = site ? [site.toLowerCase().replace(/^www\./, '')] : ['sebi.gov.in', 'amfiindia.com', 'rbi.org.in'];
  if (site && !officialPublisher(`https://${sites[0]}/`)) throw notAllowed(site);
  const q = `${query} ${sites.map((s) => `site:${s}`).join(' OR ')}`;
  let r;
  try {
    r = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Fin Advisor research agent)' }, signal: AbortSignal.timeout(20_000) });
  } catch (e) { throw new Error(`Web search unavailable (${e.message}).`); }
  if (!r.ok) throw new Error(`Web search returned HTTP ${r.status}.`);
  const html = await r.text();
  const results = [];
  for (const block of html.split(/(?=<a[^>]+class="result__a")/).slice(1)) {
    const m = block.match(/^<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>)?/);
    if (!m) continue;
    let url = decode(m[1]);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    const publisher = officialPublisher(url);
    if (!publisher || results.some((x) => x.url === url)) continue;
    results.push({ url, publisher, title: htmlText(m[2]), snippet: htmlText(m[3] ?? '') });
    if (results.length >= 6) break;
  }
  return results;
}
