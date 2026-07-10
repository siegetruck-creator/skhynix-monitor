const $ = (selector) => document.querySelector(selector);
const history = [];
const tsmcHistory = [];
let secondsUntilRefresh = 30;

const number = (value, digits = 0) => Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
const signedPercent = (value) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
const time = (value) => value ? new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(new Date(value)) : '—';
const marketState = (state) => ({ REGULAR: '장중', PRE: '프리마켓', POST: '애프터', CLOSED: '장 마감' }[state] || '확인 중');

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function setTrend(selector, value) {
  const element = $(selector);
  if (!element) return;
  element.classList.toggle('positive', value >= 0);
  element.classList.toggle('negative', value < 0);
}

function quoteChange(quote) {
  return Number.isFinite(quote.price) && Number.isFinite(quote.previousClose) && quote.previousClose !== 0
    ? (quote.price / quote.previousClose - 1) * 100
    : NaN;
}

function renderSparkline(values, premium) {
  const svg = $('#premium-sparkline');
  if (!svg) return;
  if (values.length < 2) {
    svg.innerHTML = '<line x1="0" y1="46" x2="480" y2="46" stroke="rgba(142,161,185,.25)" stroke-dasharray="4 6" />';
    return;
  }
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = Math.max(max - min, 0.01);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 480;
    const y = 82 - ((value - min) / span) * 67;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const zeroY = 82 - ((0 - min) / span) * 67;
  const color = premium >= 0 ? '#55e4c1' : '#ff7d85';
  const lastPoint = points.split(' ')[points.split(' ').length - 1];
  svg.innerHTML = `<line x1="0" y1="${zeroY.toFixed(1)}" x2="480" y2="${zeroY.toFixed(1)}" stroke="rgba(142,161,185,.23)" stroke-dasharray="4 6" /><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" /><circle cx="480" cy="${lastPoint.split(',')[1]}" r="3.5" fill="${color}" />`;
}

function render(data) {
  const { krx, adr, fx, ratio } = data;
  const krxChange = quoteChange(krx);
  const adrChange = quoteChange(adr);
  const fairPrice = krx.price / fx.price / ratio;
  const premium = ((adr.price - fairPrice) / fairPrice) * 100;

  history.push(premium);
  if (history.length > 45) history.shift();

  setText('#krx-price', number(krx.price));
  setText('#adr-price', number(adr.price, 2));
  setText('#fx-price', number(fx.price, 2));
  setText('#krx-change', signedPercent(krxChange));
  setText('#adr-change', signedPercent(adrChange));
  setText('#krx-market-state', marketState(krx.marketState));
  setText('#adr-market-state', marketState(adr.marketState));
  setText('#krx-status', `KRX ${marketState(krx.marketState)}`);
  setText('#adr-status', `NASDAQ ${marketState(adr.marketState)}`);
  setText('#adr-symbol', adr.symbol);
  setText('#calc-krw', number(krx.price));
  setText('#calc-fx', number(fx.price, 2));
  setText('#fair-price', `$${number(fairPrice, 2)}`);
  setText('#formula-result', signedPercent(premium));
  setText('#premium-value', signedPercent(premium));
  setText('#premium-label', premium >= 0 ? 'ADR 고평가' : 'ADR 저평가');
  setText('#premium-caption', `실제 ADR $${number(adr.price, 2)} · 이론가격 $${number(fairPrice, 2)}`);
  setText('#overview-sk-premium', signedPercent(premium));
  setText('#overview-sk-caption', `실제 $${number(adr.price, 2)} · 이론 $${number(fairPrice, 2)}`);
  setText('#last-updated', time(data.fetchedAt));
  setText('#updated-at', time(fx.marketTime || data.fetchedAt));
  setText('#data-source', `데이터 출처: Yahoo Finance · 조회 ${time(data.fetchedAt)}`);

  const premiumElement = $('#premium-value');
  premiumElement.classList.toggle('positive', premium >= 0);
  premiumElement.classList.toggle('negative', premium < 0);
  premiumElement.classList.remove('neutral');
  setTrend('#overview-sk-premium', premium);
  renderSparkline(history, premium);
  renderTsmc(data);
}

function renderTsmc(data) {
  const { local, adr, fx, ratio } = data.tsmc;
  const localChange = quoteChange(local);
  const adrChange = quoteChange(adr);
  const fairPrice = local.price * ratio / fx.price;
  const premium = ((adr.price - fairPrice) / fairPrice) * 100;

  tsmcHistory.push(premium);
  if (tsmcHistory.length > 45) tsmcHistory.shift();

  setText('#tsmc-local-price', number(local.price, 2));
  setText('#tsmc-adr-price', number(adr.price, 2));
  setText('#tsmc-fx-price', number(fx.price, 4));
  setText('#tsmc-local-change', signedPercent(localChange));
  setText('#tsmc-adr-change', signedPercent(adrChange));
  setText('#tsmc-local-market-state', marketState(local.marketState));
  setText('#tsmc-adr-market-state', marketState(adr.marketState));
  setText('#tsmc-calc-local', number(local.price, 2));
  setText('#tsmc-calc-fx', number(fx.price, 4));
  setText('#tsmc-fair-price', `$${number(fairPrice, 2)}`);
  setText('#tsmc-formula-result', signedPercent(premium));
  setText('#tsmc-premium-value', signedPercent(premium));
  setText('#tsmc-premium-label', premium >= 0 ? 'ADR 고평가' : 'ADR 저평가');
  setText('#tsmc-premium-caption', `실제 ADR $${number(adr.price, 2)} · 이론가격 $${number(fairPrice, 2)}`);
  setText('#overview-tsmc-premium', signedPercent(premium));
  setText('#overview-tsmc-caption', `실제 ADR $${number(adr.price, 2)} · 이론 $${number(fairPrice, 2)}`);
  setText('#tsmc-last-updated', time(data.fetchedAt));
  setText('#tsmc-updated-at', time(fx.marketTime || data.fetchedAt));

  const premiumElement = $('#tsmc-premium-value');
  premiumElement.classList.toggle('positive', premium >= 0);
  premiumElement.classList.toggle('negative', premium < 0);
  premiumElement.classList.remove('neutral');
  setTrend('#overview-tsmc-premium', premium);
  renderSparkline(tsmcHistory, premium);
}

async function loadMarketData() {
  const button = $('#refresh-button');
  button?.classList.add('loading');
  try {
    // Allow the page to work both from localhost and when index.html was opened directly.
    const apiBase = window.location.protocol === 'file:' ? 'http://localhost:3000/api/market' : '/api/market';
    const response = await fetch(`${apiBase}?ts=${Date.now()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '시장 데이터를 불러오지 못했습니다.');
    if (!Number.isFinite(data.krx?.price) || !Number.isFinite(data.adr?.price) || !Number.isFinite(data.fx?.price) || !Number.isFinite(data.tsmc?.local?.price) || !Number.isFinite(data.tsmc?.adr?.price) || !Number.isFinite(data.tsmc?.fx?.price)) {
      throw new Error('국내주식·ADR·환율 중 일부 가격이 비어 있습니다. 잠시 후 다시 시도해 주세요.');
    }
    render(data);
    $('#error-banner').hidden = true;
  } catch (error) {
    const banner = $('#error-banner');
    banner.textContent = `데이터를 불러오지 못했습니다: ${error.message}`;
    banner.hidden = false;
  } finally {
    button?.classList.remove('loading');
    secondsUntilRefresh = 30;
  }
}

$('#refresh-button')?.addEventListener('click', loadMarketData);
setInterval(() => {
  secondsUntilRefresh = Math.max(0, secondsUntilRefresh - 1);
  setText('#refresh-countdown', `${secondsUntilRefresh}초`);
  if (secondsUntilRefresh === 0) loadMarketData();
}, 1000);

loadMarketData();
