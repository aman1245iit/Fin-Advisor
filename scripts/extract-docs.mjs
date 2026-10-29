// Extracts page-wise text from official PDFs in data/docs into data/corpus.json.
// Each page keeps its document id + page number so every retrieved chunk can be cited.
import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DOCUMENTS } from '../src/engine/sources.js';

const root = path.resolve(import.meta.dirname, '..');
const out = [];

for (const doc of DOCUMENTS) {
  const file = path.join(root, 'data', 'docs', doc.file);
  if (!fs.existsSync(file)) { console.warn('missing', doc.file); continue; }
  const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    // Rebuild lines from text items using their y position.
    const lines = new Map();
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      lines.set(y, (lines.get(y) || '') + it.str + (it.hasEOL ? '' : ' '));
    }
    const text = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, t]) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    out.push({ doc: doc.id, page: p, text });
  }
  console.log(doc.id, pdf.numPages, 'pages');
}

fs.writeFileSync(path.join(root, 'data', 'corpus.json'), JSON.stringify(out));
console.log('pages written:', out.length);
