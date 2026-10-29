// Registry of official source documents used by the research assistant and fund metadata.
// Built-in documents are listed here; documents the adviser uploads are kept in
// data/user-docs.json (metadata) and data/user-corpus.json (page text) and appended at load.
import fs from 'node:fs';
import path from 'node:path';

export const DOCUMENTS = [
  {
    id: 'ppfas-fs-2026-09',
    file: 'ppfas-factsheet-sep-2026.pdf',
    title: 'PPFAS Mutual Fund – Monthly Factsheet, September 2026',
    publisher: 'PPFAS Asset Management (AMC)',
    type: 'Factsheet',
    asOf: '2026-09-30',
    url: 'https://amc.ppfas.com/downloads/factsheet/2026/ppfas-mf-factsheet-for-September-2026.pdf',
  },
  {
    id: 'nippon-fs-2026-10',
    file: 'nippon-factsheet-oct-2026.pdf',
    title: 'Nippon India Mutual Fund – Monthly Factsheet, October 2026',
    publisher: 'Nippon Life India Asset Management (AMC)',
    type: 'Factsheet',
    asOf: '2026-10-31',
    url: 'https://mf.nipponindiaim.com/InvestorServices/FactSheetsDocuments/Nippon-FS-October-2026.pdf',
  },
  {
    id: 'ppfcf-sid',
    file: 'ppfcf-sid.pdf',
    title: 'Parag Parikh Flexi Cap Fund – Scheme Information Document (data as of March 31, 2025)',
    publisher: 'PPFAS Mutual Fund, filed with SEBI',
    type: 'SID',
    asOf: '2025-03-31',
    url: 'https://www.sebi.gov.in/sebi_data/mutualfundfile/jul-2025/1751948606387.pdf',
  },
  {
    id: 'pplcf-sid',
    file: 'pplcf-sid.pdf',
    title: 'Parag Parikh Large Cap Fund – Scheme Information Document (riskometer as of August 31, 2026)',
    publisher: 'PPFAS Mutual Fund, hosted by AMFI',
    type: 'SID',
    asOf: '2026-08-31',
    url: 'https://portal.amfiindia.com/spages/14405.pdf',
  },
  {
    id: 'sebi-cat-2017',
    file: 'sebi-categorisation-2017.pdf',
    title: 'SEBI Circular SEBI/HO/IMD/DF3/CIR/P/2017/114 – Categorization and Rationalization of Mutual Fund Schemes (Oct 6, 2017)',
    publisher: 'SEBI (copy hosted by AMFI)',
    type: 'Regulation',
    asOf: '2017-10-06',
    url: 'https://www.amfiindia.com/Themes/Theme1/downloads/1507291273374.pdf',
  },
];
export const DOC_TYPES = ['Factsheet', 'SID', 'KIM', 'Regulation', 'Circular', 'Annual report', 'Other'];

const dataDir = path.resolve(import.meta.dirname, '..', '..', 'data');
export const DOCS_DIR = path.join(dataDir, 'docs');
const userDocsFile = path.join(dataDir, 'user-docs.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
for (const d of readJson(userDocsFile, [])) DOCUMENTS.push({ ...d, uploaded: true });

export function saveUserDocs() {
  fs.writeFileSync(userDocsFile, JSON.stringify(DOCUMENTS.filter((d) => d.uploaded), null, 2));
}

export const DATA_SOURCES = {
  amfiNav: { title: 'AMFI – Daily NAV of all schemes (NAVAll.txt)', url: 'https://portal.amfiindia.com/spages/NAVAll.txt' },
  navHistory: { title: 'Historical NAV by AMFI scheme code (mfapi.in mirror of AMFI data)', url: 'https://api.mfapi.in/mf/' },
  sebiCategorisation: { title: 'SEBI circular – Categorization and Rationalization of MF Schemes (Oct 2017)', url: 'https://www.sebi.gov.in/legal/circulars/oct-2017/categorization-and-rationalization-of-mutual-fund-schemes_36199.html' },
  rbiDbie: { title: 'RBI Database on Indian Economy – CPI inflation series', url: 'https://data.rbi.org.in/DBIE/' },
};

export const docById = (id) => DOCUMENTS.find((d) => d.id === id);
// Local copy served by this app (works offline); uploaded documents only exist locally.
export const localDocUrl = (d, page) => `/docs/${encodeURIComponent(d.file)}${page ? `#page=${page}` : ''}`;
export const docUrl = (d, page) => (d.uploaded ? localDocUrl(d, page) : `${d.url}${page ? `#page=${page}` : ''}`);
