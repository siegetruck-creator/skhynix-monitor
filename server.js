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

function requestJsonOnce(url) {
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

function requestJsonViaProxy(url) {
  const proxyUrl = `https://r.jina.ai/http://${url.replace(/^https:\/\//, '')}`;
  return new Promise((resolve, reject) => {
    const request = https.get(proxyUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 SKHynix-ADR-Premium-Monitor/1.0' }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Proxy returned ${response.statusCode}`));
          return;
        }
        try {
          const jsonStart = body.indexOf('{');
          const jsonEnd = body.lastIndexOf('}');
          if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('No JSON in proxy response');
          resolve(JSON.parse(body.slice(jsonStart, jsonEnd + 1)));
        } catch {
          reject(new Error('Proxy returned invalid JSON'));
        }
      });
    });
    request.setTimeout(20000, () => request.destroy(new Error('Proxy request timed out')));
    request.on('error', reject);
  });
}

async function requestJson(url) {
  const alternatives = [
    url.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com'),
    url
  ];
  const errors = [];
  for (const endpoint of alternatives) {
    try {
      return await requestJsonOnce(endpoint);
    } catch (error) {
      errors.push(error.message);
    }
  }
  try {
    return await requestJsonViaProxy(url);
  } catch (error) {
    errors.push(error.message);
    throw new Error(errors.join(' / '));
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}

function requestNasdaqJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.nasdaq.com'
      }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Nasdaq returned ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Nasdaq returned invalid JSON'));
        }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('Nasdaq request timed out')));
    request.on('error', reject);
  });
}

function parseMarketNumber(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : NaN;
}

function nasdaqMarketState(status) {
  const value = String(status || '').toLowerCase();
  if (value.includes('pre')) return 'PRE';
  if (value.includes('after')) return 'POST';
  if (value.includes('open') || value.includes('regular')) return 'REGULAR';
  return 'CLOSED';
}

async function getNasdaqQuote(symbol) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`;
  const payload = await requestNasdaqJson(url);
  const data = payload?.data;
  const price = parseMarketNumber(data?.primaryData?.lastSalePrice);
  if (!data || !Number.isFinite(price)) throw new Error(`${symbol}: Nasdaq quote unavailable`);

  const netChange = parseMarketNumber(data.primaryData?.netChange);
  const secondaryClose = parseMarketNumber(data.secondaryData?.lastSalePrice);
  const previousClose = Number.isFinite(secondaryClose)
    ? secondaryClose
    : (Number.isFinite(netChange) ? price - netChange : NaN);
  const time = Date.parse(data.primaryData?.lastTradeTimestamp || '');

  return {
    symbol,
    price,
    previousClose,
    currency: 'USD',
    exchange: data.exchange || 'NASDAQ',
    marketState: nasdaqMarketState(data.marketStatus),
    marketTime: Number.isFinite(time) ? time : Date.now(),
    points: []
  };
}

function activeMarketSession(meta, now = Date.now()) {
  const periods = meta.currentTradingPeriod || {};
  for (const [state, period] of Object.entries({ PRE: periods.pre, REGULAR: periods.regular, POST: periods.post })) {
    const start = Number(period?.start) * 1000;
    const end = Number(period?.end) * 1000;
    if (Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end) {
      return { state, start, end };
    }
  }
  return { state: meta.marketState || 'CLOSED', start: NaN, end: NaN };
}

function latestPriceInSession(points, session) {
  if (!Number.isFinite(session.start) || !Number.isFinite(session.end)) return null;
  return [...points]
    .reverse()
    .find((point) => point.time >= session.start && point.time < session.end) || null;
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
  const points = timestamps
    .map((timestamp, index) => ({
      time: timestamp * 1000,
      price: Number(closes[index])
    }))
    .filter((point) => Number.isFinite(point.price));

  // For US symbols Yahoo includes pre-market and after-hours one-minute bars.
  // Use them only while their session is open; after the session ends, keep the regular close.
  const session = activeMarketSession(meta);
  const extendedPoint = session.state === 'PRE' || session.state === 'POST'
    ? latestPriceInSession(points, session)
    : null;
  const lastIntradayClose = points.at(-1)?.price;
  const regularPrice = Number(meta.regularMarketPrice ?? lastIntradayClose);
  const price = extendedPoint?.price ?? regularPrice;
  if (!Number.isFinite(price)) throw new Error(`${symbol}: invalid price`);

  return {
    symbol,
    price,
    previousClose: Number(meta.previousClose ?? meta.chartPreviousClose ?? NaN),
    currency: meta.currency || '',
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    marketState: session.state,
    marketTime: extendedPoint?.time ?? Number(meta.regularMarketTime || timestamps[timestamps.length - 1] || 0) * 1000,
    points
  };
}

async function getYahooHistory(symbol) {
  const url = `${yahooBase}${encodeURIComponent(symbol)}?interval=1mo&range=10y&includePrePost=false`;
  const payload = await requestJson(url);
  const result = payload?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`${symbol}: no historical data`);
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = (result.timestamp || [])
    .map((timestamp, index) => ({ time: timestamp * 1000, price: Number(closes[index]) }))
    .filter((point) => Number.isFinite(point.price));
  if (!points.length) throw new Error(`${symbol}: no historical points`);
  return { symbol, points };
}

async function getAdrQuote(preferred, fallback) {
  try {
    return await getYahooQuote(preferred);
  } catch (error) {
    return getYahooQuote(fallback);
  }
}

async function getUsAdrQuote(preferred, fallback) {
  try {
    return await getNasdaqQuote(preferred);
  } catch {
    try {
      return await getNasdaqQuote(fallback);
    } catch {
      return getAdrQuote(preferred, fallback);
    }
  }
}

async function getHistoryWithFallback(preferred, fallback) {
  try {
    return await getYahooHistory(preferred);
  } catch (error) {
    return getYahooHistory(fallback);
  }
}

async function fetchMarketData() {
  const cutover = new Date('2026-07-13T00:00:00+09:00');
  const now = new Date();
  const preferredAdr = now >= cutover ? 'SKHY' : 'SKHYV';
  const adrCandidates = preferredAdr === 'SKHY' ? ['SKHY', 'SKHYV'] : ['SKHYV', 'SKHY'];

  const [krx, fx, tsmcTaiwan, tsmcFx, adr] = await Promise.all([
    getYahooQuote('000660.KS'),
    getYahooQuote('KRW=X'),
    getYahooQuote('2330.TW'),
    getYahooQuote('TWD=X'),
    getUsAdrQuote(adrCandidates[0], adrCandidates[1])
  ]);
  const tsmcAdr = await getUsAdrQuote('TSM', 'TSM');

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

let marketCache = null;
let marketCacheAt = 0;
let marketRequest = null;
const marketCacheMs = 20000;

async function getMarketData() {
  if (marketCache && Date.now() - marketCacheAt < marketCacheMs) return marketCache;
  if (marketRequest) return marketRequest;
  marketRequest = fetchMarketData()
    .then((data) => {
      marketCache = data;
      marketCacheAt = Date.now();
      return data;
    })
    .finally(() => {
      marketRequest = null;
    });
  return marketRequest;
}

function monthKey(timestamp, timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

function monthStart(key) {
  return `${key}-01T00:00:00.000Z`;
}

function toMonthMap(history, timeZone) {
  const map = new Map();
  for (const point of [...history.points].sort((a, b) => a.time - b.time)) {
    // The last monthly close in a month wins, which also handles month-end holidays.
    map.set(monthKey(point.time, timeZone), point.price);
  }
  return map;
}

let historyCache = null;
let historyCacheAt = 0;
let historyRequest = null;
const historyCacheMs = 300000;

async function fetchHistoryData() {
  const market = await getMarketData();
  const cutover = new Date('2026-07-13T00:00:00+09:00');
  const preferredAdr = new Date() >= cutover ? 'SKHY' : 'SKHYV';
  const fallbackAdr = preferredAdr === 'SKHY' ? 'SKHYV' : 'SKHY';
  const [skLocal, skFx, skAdr, tsmcLocal, tsmcFx, tsmcAdr] = await Promise.all([
    getYahooHistory('000660.KS'),
    getYahooHistory('KRW=X'),
    getHistoryWithFallback(preferredAdr, fallbackAdr),
    getYahooHistory('2330.TW'),
    getYahooHistory('TWD=X'),
    getYahooHistory('TSM')
  ]);

  const maps = {
    skLocal: toMonthMap(skLocal, 'Asia/Seoul'), skFx: toMonthMap(skFx, 'Asia/Seoul'), skAdr: toMonthMap(skAdr, 'Asia/Seoul'),
    tsmcLocal: toMonthMap(tsmcLocal, 'Asia/Taipei'), tsmcFx: toMonthMap(tsmcFx, 'Asia/Taipei'), tsmcAdr: toMonthMap(tsmcAdr, 'Asia/Taipei')
  };
  const keys = [...new Set([...maps.skLocal.keys(), ...maps.tsmcLocal.keys()])].sort();
  const currentKey = monthKey(Date.now(), 'Asia/Seoul');
  const ensureCurrent = (map, value) => map.set(currentKey, value);
  ensureCurrent(maps.skLocal, market.krx.price);
  ensureCurrent(maps.skFx, market.fx.price);
  ensureCurrent(maps.skAdr, market.adr.price);
  ensureCurrent(maps.tsmcLocal, market.tsmc.local.price);
  ensureCurrent(maps.tsmcFx, market.tsmc.fx.price);
  ensureCurrent(maps.tsmcAdr, market.tsmc.adr.price);
  if (!keys.includes(currentKey)) keys.push(currentKey);
  keys.sort();

  const sk = keys.map((key) => {
    const fair = maps.skLocal.get(key) && maps.skFx.get(key) ? maps.skLocal.get(key) / 10 / maps.skFx.get(key) : NaN;
    const adr = maps.skAdr.get(key);
    return { date: monthStart(key), premium: Number.isFinite(fair) && Number.isFinite(adr) ? (adr / fair - 1) * 100 : null };
  });
  const tsmc = keys.map((key) => {
    const fair = maps.tsmcLocal.get(key) && maps.tsmcFx.get(key) ? maps.tsmcLocal.get(key) * 5 / maps.tsmcFx.get(key) : NaN;
    const adr = maps.tsmcAdr.get(key);
    return { date: monthStart(key), premium: Number.isFinite(fair) && Number.isFinite(adr) ? (adr / fair - 1) * 100 : null };
  });

  return { generatedAt: Date.now(), currentMonth: monthStart(currentKey), sk, tsmc };
}

async function getHistoryData() {
  if (historyCache && Date.now() - historyCacheAt < historyCacheMs) return historyCache;
  if (historyRequest) return historyRequest;
  historyRequest = fetchHistoryData()
    .then((data) => { historyCache = data; historyCacheAt = Date.now(); return data; })
    .finally(() => { historyRequest = null; });
  return historyRequest;
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

  if (pathname === '/api/history') {
    try {
      return json(res, 200, await getHistoryData());
    } catch (error) {
      return json(res, 502, { error: error.message || 'Historical market data unavailable' });
    }
  }

  return serveStatic(req, res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`SK Hynix ADR monitor: http://localhost:${port}`);
});
