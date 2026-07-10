import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./public', import.meta.url));
const port = Number(process.env.PORT || 3000);
const yahooBase = 'https://query1.finance.yahoo.com/v8/finance/chart/';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 SKHynix-ADR-Premium-Monitor/1.0' }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Yahoo Finance returned ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Yahoo Finance returned invalid JSON'));
        }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('Yahoo Finance request timed out')));
    request.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}

async function getYahooQuote(symbol) {
  const url = `${yahooBase}${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const payload = await requestJson(url);
  const result = payload?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`${symbol}: no quote data`);

  const meta = result.meta;
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const lastIntradayClose = [...closes].reverse().find((value) => Number.isFinite(value));
  const price = Number(meta.regularMarketPrice ?? lastIntradayClose);
  if (!Number.isFinite(price)) throw new Error(`${symbol}: invalid price`);

  const points = timestamps
    .map((timestamp, index) => ({
      time: timestamp * 1000,
      price: Number(closes[index])
    }))
    .filter((point) => Number.isFinite(point.price));

  return {
    symbol,
    price,
    previousClose: Number(meta.previousClose ?? meta.chartPreviousClose ?? NaN),
    currency: meta.currency || '',
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    marketState: meta.marketState || 'UNKNOWN',
    marketTime: Number(meta.regularMarketTime || timestamps[timestamps.length - 1] || 0) * 1000,
    points
  };
}

async function getMarketData() {
  const cutover = new Date('2026-07-13T00:00:00+09:00');
  const now = new Date();
  const preferredAdr = now >= cutover ? 'SKHY' : 'SKHYV';
  const adrCandidates = preferredAdr === 'SKHY' ? ['SKHY', 'SKHYV'] : ['SKHYV', 'SKHY'];

  const [krx, fx, tsmcTaiwan, tsmcFx, ...adrResults] = await Promise.all([
    getYahooQuote('000660.KS'),
    getYahooQuote('KRW=X'),
    getYahooQuote('2330.TW'),
    getYahooQuote('TWD=X'),
    ...adrCandidates.map((symbol) => getYahooQuote(symbol).catch((error) => ({ error: error.message })))
  ]);
  const adr = adrResults.find((quote) => !quote.error);
  if (!adr) throw new Error(adrResults.map((item) => item.error).join(' / '));
  const tsmcAdr = await getYahooQuote('TSM');

  return {
    fetchedAt: Date.now(),
    ratio: 10,
    cutover: cutover.toISOString(),
    krx,
    adr,
    fx,
    tsmc: {
      ratio: 5,
      local: tsmcTaiwan,
      adr: tsmcAdr,
      fx: tsmcFx
    }
  };
}

async function serveStatic(req, res) {
  const requestedPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = normalize(join(root, requestedPath));
  if (!filePath.startsWith(root)) return json(res, 403, { error: 'Forbidden' });

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/api/market') {
    try {
      return json(res, 200, await getMarketData());
    } catch (error) {
      return json(res, 502, { error: error.message || 'Market data unavailable' });
    }
  }

  return serveStatic(req, res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`SK Hynix ADR monitor: http://localhost:${port}`);
});
