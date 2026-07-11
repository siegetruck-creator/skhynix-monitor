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

function renderHistory(data) {
  const svg = $('#history-chart');
  const loading = $('#history-loading');
  if (!svg) return;

  const width = 1000;
  const height = 420;
  const pad = { top: 22, right: 25, bottom: 48, left: 66 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const series = [
    { values: data.sk, color: '#55e4c1', name: 'SK하이닉스 ADR' },
    { values: data.tsmc, color: '#7ba9ff', name: 'TSMC ADR' }
  ];
  const allPoints = series.flatMap((item) => item.values);
  const startTime = Math.min(...allPoints.map((point) => new Date(point.date).getTime()));
  const currentTime = new Date(data.currentMonth).getTime();
  const endDate = new Date(data.currentMonth);
  endDate.setUTCMonth(endDate.getUTCMonth() + 12);
  const endTime = endDate.getTime();
  const values = allPoints.map((point) => point.premium).filter(Number.isFinite);
  if (!values.length) throw new Error('그래프로 표시할 프리미엄 데이터가 없습니다.');
  let min = Math.min(...values, 0);
  let max = Math.max(...values, 0);
  const margin = Math.max((max - min) * 0.12, 2);
  min -= margin;
  max += margin;
  const x = (timeValue) => pad.left + ((timeValue - startTime) / (endTime - startTime)) * plotWidth;
  const y = (value) => pad.top + ((max - value) / (max - min)) * plotHeight;
  const pathFor = (points) => {
    let path = '';
    let connected = false;
    for (const point of points) {
      if (!Number.isFinite(point.premium)) {
        continue;
      }
      path += `${connected ? 'L' : 'M'}${x(new Date(point.date).getTime()).toFixed(1)},${y(point.premium).toFixed(1)} `;
      connected = true;
    }
    return path.trim();
  };
  const grid = [];
  for (let index = 0; index <= 4; index += 1) {
    const value = max - ((max - min) * index / 4);
    const lineY = y(value);
    grid.push(`<line x1="${pad.left}" y1="${lineY.toFixed(1)}" x2="${width - pad.right}" y2="${lineY.toFixed(1)}" class="chart-grid-line" /><text x="${pad.left - 10}" y="${(lineY + 4).toFixed(1)}" text-anchor="end" class="chart-axis-label">${signedPercent(value)}</text>`);
  }
  const ticks = [];
  const startYear = new Date(startTime).getUTCFullYear();
  const endYear = endDate.getUTCFullYear();
  for (let year = startYear; year <= endYear; year += 2) {
    const tickTime = Date.UTC(year, 0, 1);
    if (tickTime < startTime || tickTime > endTime) continue;
    const tickX = x(tickTime);
    ticks.push(`<line x1="${tickX.toFixed(1)}" y1="${pad.top}" x2="${tickX.toFixed(1)}" y2="${height - pad.bottom}" class="chart-grid-line vertical" /><text x="${tickX.toFixed(1)}" y="${height - 18}" text-anchor="middle" class="chart-axis-label">${year}</text>`);
  }
  const lastPoint = (points) => [...points].reverse().find((point) => Number.isFinite(point.premium));
  const currentDots = series.map((item) => {
    const point = lastPoint(item.values);
    return point ? `<circle cx="${x(new Date(point.date).getTime()).toFixed(1)}" cy="${y(point.premium).toFixed(1)}" r="4.5" fill="${item.color}" class="chart-current-dot" />` : '';
  }).join('');
  const paths = series.map((item) => `<path d="${pathFor(item.values)}" fill="none" stroke="${item.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`).join('');
  const hoverPoints = series.flatMap((item) => item.values.filter((point) => Number.isFinite(point.premium)).map((point) => {
    const pointX = x(new Date(point.date).getTime()).toFixed(1);
    const pointY = y(point.premium).toFixed(1);
    const month = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(point.date));
    return `<circle cx="${pointX}" cy="${pointY}" r="8" class="chart-hover-point" data-series="${item.name}" data-month="${month}" data-premium="${point.premium.toFixed(1)}" />`;
  })).join('');
  svg.innerHTML = `${grid.join('')}${ticks.join('')}${paths}${currentDots}${hoverPoints}`;
  const tooltip = $('#history-tooltip');
  const card = svg.closest('.history-card');
  const showTooltip = (point, event) => {
    if (!tooltip || !card) return;
    tooltip.innerHTML = `<strong>${point.dataset.series}</strong><span>${point.dataset.month} · ${point.dataset.premium >= 0 ? '+' : ''}${point.dataset.premium}%</span>`;
    tooltip.hidden = false;
    const cardRect = card.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const left = Math.min(cardRect.width - tooltipWidth - 10, Math.max(10, event.clientX - cardRect.left + 12));
    const top = Math.min(cardRect.height - tooltipHeight - 10, Math.max(10, event.clientY - cardRect.top - tooltipHeight - 12));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  svg.querySelectorAll('.chart-hover-point').forEach((point) => {
    point.addEventListener('mouseenter', (event) => showTooltip(point, event));
    point.addEventListener('mousemove', (event) => showTooltip(point, event));
    point.addEventListener('mouseleave', () => { if (tooltip) tooltip.hidden = true; });
  });
  if (loading) loading.hidden = true;
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

async function loadHistoryData() {
  try {
    const response = await fetch(`/api/history?ts=${Date.now()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '과거 데이터를 불러오지 못했습니다.');
    renderHistory(data);
  } catch (error) {
    const loading = $('#history-loading');
    if (loading) {
      loading.hidden = false;
      loading.textContent = `과거 데이터를 불러오지 못했습니다: ${error.message}`;
    }
  }
}

$('#refresh-button')?.addEventListener('click', loadMarketData);
setInterval(() => {
  secondsUntilRefresh = Math.max(0, secondsUntilRefresh - 1);
  setText('#refresh-countdown', `${secondsUntilRefresh}초`);
  if (secondsUntilRefresh === 0) loadMarketData();
}, 1000);

loadMarketData();
loadHistoryData();
