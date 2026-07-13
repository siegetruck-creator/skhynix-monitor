import http from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import multer from 'multer';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(here, 'public');
const uploadDir = join(here, 'uploads');
const configPath = join(here, 'config.json');
const port = Number(process.env.PORT || 3000);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

process.on('uncaughtException', (error) => console.error('처리되지 않은 오류:', error));
process.on('unhandledRejection', (error) => console.error('처리되지 않은 요청 오류:', error));

async function config() {
  try { return JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('설정 파일이 없습니다. setup.bat를 먼저 실행해 주세요.');
    throw new Error('config.json 형식이 올바르지 않습니다. 내용을 확인해 주세요.');
  }
}
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function fail(res, status, message) { send(res, status, { error: message }); }
function cleanText(value) { return String(value ?? '').trim(); }
function missingEvidence(metric) {
  return !cleanText(metric.source_sentence) || !Number.isInteger(Number(metric.page)) || Number(metric.page) < 1;
}
function verifyMetrics(metrics, filename) {
  return (Array.isArray(metrics) ? metrics : []).map((item) => {
    const metric = { ...item, filename, confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'low' };
    if (missingEvidence(metric)) { metric.review_required = true; metric.confidence = 'low'; metric.review_reason = '\uD398\uC774\uC9C0 \uBC88\uD638 \uB610\uB294 \uC6D0\uBB38 \uADFC\uAC70\uAC00 \uC5C6\uC5B4 \uAC80\uD1A0\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.'; }
    if (!['GAAP', 'Non-GAAP', 'Unclassified'].includes(metric.accounting)) { metric.accounting = 'Unclassified'; metric.review_required = true; metric.review_reason = 'GAAP/Non-GAAP \uAD6C\uBD84\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.'; }
    return metric;
  });
}
function notionProperty(definition, value) {
  if (!definition || value === undefined || value === null || value === '') return undefined;
  if (definition.type === 'select') return { select: { name: String(value) } };
  if (definition.type === 'multi_select') return { multi_select: [{ name: String(value) }] };
  if (definition.type === 'rich_text') return { rich_text: [{ text: { content: String(value) } }] };
  if (definition.type === 'date') return { date: { start: String(value) } };
  if (definition.type === 'url') return { url: String(value) };
  if (definition.type === 'number' && Number.isFinite(Number(value))) return { number: Number(value) };
  return undefined;
}
function quarterLabel(quarter) { const found = String(quarter).match(/([1-4])\s*(?:분기|Q)/i); return found ? `${found[1]}Q` : '검토 필요'; }
function fiscalYear(quarter) { const found = String(quarter).match(/(20\d{2})/); return found ? `FY${found[1]}` : '검토 필요'; }
function shortQuarter(quarter) { const label = quarterLabel(quarter); const year = String(quarter).match(/20(\d{2})/)?.[1]; return label === '검토 필요' || !year ? '검토 필요' : `${label}${year}`; }
function runPython(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [join(here, 'python', 'calculations.py')], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', () => reject(new Error('Python을 실행할 수 없습니다. setup.bat를 다시 실행해 주세요.')));
    child.on('close', (code) => { try { if (code) throw new Error(err); resolve(JSON.parse(out)); } catch { reject(new Error('계산 결과를 만들지 못했습니다.')); } });
    child.stdin.end(JSON.stringify(payload));
  });
}
function runCalculator(metrics) { return runPython({ metrics }); }
function runTrendCalculator(snapshots) { return runPython({ snapshots }); }
async function extractPdf(buffer) {
  const document = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let i = 1; i <= document.numPages; i += 1) { const page = await document.getPage(i); const content = await page.getTextContent(); pages.push(content.items.map((x) => x.str).join(' ')); }
  await document.destroy();
  return pages.map((text, index) => `[페이지 ${index + 1}]\n${text}`).join('\n\n');
}
async function callOpenAI({ text, imageDataUrl, company, ticker, quarter }) {
  const { openai_api_key, openai_model = 'gpt-4.1-mini' } = await config();
  if (!openai_api_key || openai_api_key.includes('OpenAI API')) throw new Error('config.json\uC5D0 OpenAI API \uD0A4\uB97C \uC785\uB825\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.');
  const schema = {
    name: 'ir_analysis', strict: true,
    schema: { type: 'object', additionalProperties: false, required: ['summary', 'investor_summary', 'guidance', 'management_comments', 'investment_implications', 'metrics'], properties: {
      summary: { type: 'string' }, investor_summary: { type: 'string' }, guidance: { type: 'array', items: { type: 'string' } }, management_comments: { type: 'array', items: { type: 'string' } }, investment_implications: { type: 'array', items: { type: 'string' } },
      metrics: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name','value','currency','unit','period','accounting','page','source_sentence','confidence','review_required'], properties: { name: { type: 'string' }, value: { type: ['number','null'] }, currency: { type: 'string' }, unit: { type: 'string' }, period: { type: 'string' }, accounting: { type: 'string', enum: ['GAAP','Non-GAAP','Unclassified'] }, page: { type: ['integer','null'] }, source_sentence: { type: 'string' }, confidence: { type: 'string', enum: ['high','medium','low'] }, review_required: { type: 'boolean' } } } }
    } }
  };
  const prompt = `당신은 보수적인 기업 IR 분석 보조자입니다. 기업: ${company}, 티커: ${ticker}, 회계분기: ${quarter}. 제공된 자료만 사용하세요. 숫자를 계산하거나 추측하지 마세요. 확인되지 않는 내용은 빈 배열 또는 '검토 필요'로 남기세요. metrics에는 매출, 영업이익, 순이익, EPS가 자료에 있을 때만 넣고, 반드시 원문 문장과 실제 페이지 번호를 넣으세요. GAAP/Non-GAAP을 문서 표현에 따라 분리하세요. investor_summary는 실적 변화, 가이던스, 촉매, 위험을 3~5문장으로 압축하되 사실과 해석을 구분해 한국어로 쓰세요. 투자 시사점은 사실과 해석을 구분하는 조심스러운 문장으로 쓰세요.`;
  const content = [{ type: 'text', text: `${prompt}\n\n자료:\n${text || '이미지 자료를 확인하세요.'}` }];
  if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } });
  const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openai_api_key}` }, body: JSON.stringify({ model: openai_model, messages: [{ role: 'user', content }], response_format: { type: 'json_schema', json_schema: schema }, temperature: 0 }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'AI 분석 요청에 실패했습니다.');
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}
const storage = multer.diskStorage({ destination: async (_req, _file, cb) => { await mkdir(uploadDir, { recursive: true }); cb(null, uploadDir); }, filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`) });
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024, files: 10 }, fileFilter: (_req, file, cb) => cb(null, ['application/pdf','image/png','image/jpeg'].includes(file.mimetype)) }).array('files', 10);
function uploadRequest(req, res) { return new Promise((resolve, reject) => upload(req, res, (e) => e ? reject(e) : resolve())); }
async function analyze(req, res) {
  let files = [];
  try { await uploadRequest(req, res); files = req.files || []; if (!files.length) return fail(res, 400, 'PDF 또는 PNG/JPG 파일을 하나 이상 선택해 주세요.');
    const { company, ticker, quarter } = req.body; if (![company, ticker, quarter].every(cleanText)) return fail(res, 400, '기업명, 티커, 회계 분기를 모두 입력해 주세요.');
    const analyses = [];
    for (const file of files) {
      const buffer = await readFile(file.path); const isPdf = file.mimetype === 'application/pdf';
      const text = isPdf ? await extractPdf(buffer) : '';
      if (isPdf && !cleanText(text)) throw new Error(`${file.originalname}: PDF에서 읽을 수 있는 텍스트가 없습니다. 이미지로 된 PDF는 PNG/JPG로 변환해 올려 주세요.`);
      const imageDataUrl = isPdf ? null : `data:${file.mimetype};base64,${buffer.toString('base64')}`;
      const analysis = await callOpenAI({ text, imageDataUrl, company, ticker, quarter });
      analysis.metrics = verifyMetrics(analysis.metrics, file.originalname); analysis.calculations = await runCalculator(analysis.metrics); analysis.meta = { company, ticker, quarter, filename: file.originalname, analyzed_at: new Date().toISOString() };
      analyses.push(analysis);
    }
    send(res, 200, { analyses });
  } catch (error) { fail(res, error.code === 'LIMIT_FILE_SIZE' ? 400 : 500, error.code === 'LIMIT_FILE_SIZE' ? '파일은 15MB 이하만 업로드할 수 있습니다.' : (error.message || '분석 중 문제가 발생했습니다.')); }
  finally { files.forEach((file) => { if (file?.path) rm(file.path, { force: true }).catch(() => {}); }); }
}
async function body(req) { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw || '{}'); }
async function notion(req, res) {
  try {
    const settings = await config();
    const token = settings.notion_api_key;
    const parentId = settings.notion_parent_id || settings.notion_database_id;
    if (!token || !parentId || token.includes('Notion')) return fail(res, 400, 'Notion 설정이 없습니다. config.json에 Notion 키와 저장 위치 ID를 입력해 주세요.');
    const data = await body(req);
    if (!data?.approved || !data?.analysis?.meta) return fail(res, 400, '화면에서 분석 결과를 확인한 뒤 저장을 승인해 주세요.');
    const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
    const a = data.analysis;
    const title = `${a.meta.company} ${a.meta.quarter} IR 분석`;
    const lines = [`기업: ${a.meta.company} (${a.meta.ticker})`, `분기: ${a.meta.quarter}`, '', '투자자 요약', a.investor_summary || '검토 필요', '', '가이던스', ...(a.guidance || ['검토 필요']), '', '실적 수치'];
    for (const m of a.metrics || []) lines.push(`${m.name}: ${m.value ?? '검토 필요'} ${m.currency} ${m.unit} | ${m.accounting} | ${m.filename} p.${m.page ?? '?'} | ${m.confidence} | ${m.source_sentence}`);
    const databaseResponse = await fetch(`https://api.notion.com/v1/databases/${parentId}`, { headers });
    const database = await databaseResponse.json();
    let parent;
    let properties;
    if (databaseResponse.ok) {
      const titleProperty = Object.entries(database.properties || {}).find(([, value]) => value.type === 'title')?.[0];
      if (!titleProperty) throw new Error('Notion 표에서 제목 열을 찾을 수 없습니다.');
      parent = { database_id: parentId };
      properties = { [titleProperty]: { title: [{ text: { content: title } }] } };
      const values = {
        회사: a.meta.company,
        기업: a.meta.company,
        티커: a.meta.ticker,
        분기: quarterLabel(a.meta.quarter),
        '분기(예: 1Q26)': shortQuarter(a.meta.quarter),
        회계연도: fiscalYear(a.meta.quarter),
        유형: 'IR 분석',
        자료종류: 'IR 분석',
        날짜: a.meta.analyzed_at.slice(0, 10),
        발표일: a.meta.analyzed_at.slice(0, 10),
        요약: a.summary || '검토 필요',
        태그: 'IR 분석'
      };
      for (const [name, value] of Object.entries(values)) {
        const property = notionProperty(database.properties[name], value);
        if (property) properties[name] = property;
      }
    } else if (database.code === 'validation_error' && String(database.message).includes('is a page')) {
      const pageResponse = await fetch(`https://api.notion.com/v1/pages/${parentId}`, { headers });
      if (!pageResponse.ok) throw new Error('Notion 저장 페이지에 접근할 수 없습니다. 연결 공유 설정을 확인해 주세요.');
      parent = { page_id: parentId };
      properties = { title: { title: [{ text: { content: title } }] } };
    } else {
      throw new Error(database.message || 'Notion 저장 위치를 찾을 수 없습니다.');
    }
    const trendData = JSON.stringify({ meta: a.meta, metrics: (a.metrics || []).slice(0, 8).map((m) => ({ name: m.name, value: m.value, currency: m.currency, unit: m.unit })), guidance: (a.guidance || []).slice(0, 4).map((g) => String(g).slice(0, 220)) });
    const visibleBlocks = lines.map((line) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: line.slice(0, 1900) } }] } }));
    const systemBlock = { object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: '자동 분석 데이터' } }], children: [{ object: 'block', type: 'code', code: { language: 'json', rich_text: [{ type: 'text', text: { content: trendData.slice(0, 1900) } }] } }] } };
    const response = await fetch('https://api.notion.com/v1/pages', { method: 'POST', headers, body: JSON.stringify({ parent, properties, children: [...visibleBlocks, systemBlock] }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Notion 저장에 실패했습니다.');
    send(res, 200, { url: result.url });
  } catch (e) { fail(res, 500, e.message || 'Notion 저장 중 문제가 발생했습니다.'); }
}
async function trends(req, res) {
  try {
    const ticker = new URL(req.url, 'http://localhost').searchParams.get('ticker')?.trim();
    if (!ticker) return fail(res, 400, '티커가 필요합니다.');
    const settings = await config();
    const token = settings.notion_api_key;
    const databaseId = settings.notion_database_id;
    if (!token || !databaseId) return fail(res, 400, 'Notion 설정이 없습니다.');
    const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
    const databaseResponse = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, { headers });
    const database = await databaseResponse.json();
    if (!databaseResponse.ok) throw new Error(database.message || 'Notion 표를 읽을 수 없습니다.');
    const query = { page_size: 100 };
    if (database.properties?.티커?.type === 'rich_text') query.filter = { property: '티커', rich_text: { equals: ticker } };
    const queryResponse = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, { method: 'POST', headers, body: JSON.stringify(query) });
    const queryResult = await queryResponse.json();
    if (!queryResponse.ok) throw new Error(queryResult.message || 'Notion 저장 자료를 조회할 수 없습니다.');
    const snapshots = [];
    for (const page of queryResult.results || []) {
      const blocksResponse = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, { headers });
      const blocks = await blocksResponse.json();
      const toggle = (blocks.results || []).find((block) => block.type === 'toggle' && block.toggle?.rich_text?.[0]?.plain_text === '자동 분석 데이터');
      if (!toggle) continue;
      const childrenResponse = await fetch(`https://api.notion.com/v1/blocks/${toggle.id}/children?page_size=10`, { headers });
      const children = await childrenResponse.json();
      const code = (children.results || []).find((block) => block.type === 'code');
      const raw = code?.code?.rich_text?.map((part) => part.plain_text).join('');
      if (!raw) continue;
      try {
        const saved = JSON.parse(raw);
        if (saved.meta?.ticker === ticker) snapshots.push({ quarter: saved.meta.quarter, date: saved.meta.analyzed_at, metrics: saved.metrics || [], guidance: saved.guidance || [] });
      } catch { /* Old or incomplete saved data is ignored safely. */ }
    }
    const trend = await runTrendCalculator(snapshots);
    const guidanceHistory = snapshots.sort((a, b) => String(a.date).localeCompare(String(b.date))).map((item) => ({ quarter: item.quarter, guidance: item.guidance }));
    send(res, 200, { trend: trend.items, guidanceHistory });
  } catch (error) { fail(res, 500, error.message || '추세 데이터를 만들지 못했습니다.'); }
}
async function staticFile(req, res) { const path = normalize(join(publicDir, req.url === '/' ? 'index.html' : req.url.split('?')[0])); if (!path.startsWith(publicDir)) return fail(res, 403, '접근할 수 없습니다.'); try { res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }); res.end(await readFile(path)); } catch { fail(res, 404, '화면 파일을 찾을 수 없습니다.'); } }
http.createServer(async (req, res) => { const path = (req.url || '/').split('?')[0]; if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, configured: existsSync(configPath) }); if (req.method === 'GET' && path === '/api/trends') return trends(req, res); if (req.method === 'POST' && path === '/api/analyze') return analyze(req, res); if (req.method === 'POST' && path === '/api/notion') return notion(req, res); if (req.method === 'GET') return staticFile(req, res); fail(res, 405, '허용되지 않은 요청입니다.'); }).listen(port, () => { console.log(`IR 리포트 분석기 실행 중: http://localhost:${port}`); const browser = spawn('cmd.exe', ['/c', 'start', '', `http://localhost:${port}`], { detached: true, stdio: 'ignore', windowsHide: true }); browser.unref(); });
