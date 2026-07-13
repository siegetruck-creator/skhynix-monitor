const $ = (selector) => document.querySelector(selector);
let analysis;
let analyses = [];
let currentIndex = 0;

const korean = (value) => ({ high: '높음', medium: '보통', low: '낮음', Unclassified: '미구분' }[value] || value);
function note(text, bad = false) { const el = $('#message'); el.textContent = text; el.className = `message ${bad ? 'bad' : ''}`; el.hidden = false; }
function list(id, values) { $(id).innerHTML = (values?.length ? values : ['검토 필요']).map((x) => `<li>${x}</li>`).join(''); }
function fmt(metric) { return typeof metric.value === 'number' ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(metric.value) : '검토 필요'; }
function drawChart(metrics) { const data = metrics.filter((m) => typeof m.value === 'number').slice(0, 5); const max = Math.max(...data.map((m) => Math.abs(m.value)), 1); $('#chart').innerHTML = data.length ? data.map((m) => `<div class="bar-row"><span>${m.name}</span><div class="bar"><i style="width:${Math.max(4, Math.abs(m.value) / max * 100)}%"></i></div><b>${fmt(m)}</b></div>`).join('') : '<p>그래프로 표시할 확인된 수치가 없습니다. 검토 필요</p>'; }
function drawTrend(items) {
  const values = items.filter((item) => typeof item.revenue === 'number');
  const max = Math.max(...values.map((item) => Math.abs(item.revenue)), 1);
  $('#trend-chart').innerHTML = values.length ? values.map((item) => `<div class="bar-row"><span>${item.quarter}</span><div class="bar"><i style="width:${Math.max(4, Math.abs(item.revenue) / max * 100)}%"></i></div><b>매출 ${new Intl.NumberFormat('ko-KR').format(item.revenue)}${item.operating_margin === null ? '' : ` · 영업이익률 ${item.operating_margin}%`}</b></div>`).join('') : '<p>아직 누적된 같은 기업의 저장 자료가 부족합니다. 앞으로 저장하는 분석부터 추세에 반영됩니다.</p>';
}
async function loadTrends(ticker) {
  $('#trend-chart').innerHTML = '<p>Notion에 저장된 분기 자료를 확인하고 있습니다.</p>';
  try {
    const response = await fetch(`/api/trends?ticker=${encodeURIComponent(ticker)}`); const data = await response.json(); if (!response.ok) throw new Error(data.error);
    drawTrend(data.trend || []);
    const rows = (data.guidanceHistory || []).filter((item) => item.guidance?.length);
    $('#guidance-history').innerHTML = rows.length ? rows.map((item) => `<article class="guidance-row"><b>${item.quarter}</b><span>${item.guidance.map((text) => `<div>${text}</div>`).join('')}</span></article>`).join('') : '<p>비교할 이전 가이던스가 아직 없습니다.</p>';
  } catch (error) { $('#trend-chart').innerHTML = `<p>추세를 불러오지 못했습니다: ${error.message}</p>`; $('#guidance-history').innerHTML = ''; }
}
function renderCurrent() {
  analysis = analyses[currentIndex];
  const a = analysis;
  $('#review').hidden = false;
  $('#title').textContent = `${a.meta.company} ${a.meta.quarter} 분석 초안`;
  $('#batch-status').textContent = analyses.length > 1 ? `${currentIndex + 1} / ${analyses.length}번째 파일: ${a.meta.filename}` : '아래 근거를 확인한 후에만 저장해 주세요.';
  $('#summary').textContent = a.summary || '검토 필요'; $('#investor-summary').textContent = a.investor_summary || '검토 필요'; list('#guidance', a.guidance); list('#comments', a.management_comments); list('#implications', a.investment_implications);
  $('#metrics').innerHTML = a.metrics.map((m) => `<tr><td>${m.name}${m.review_required ? '<em>검토 필요</em>' : ''}</td><td>${fmt(m)}<small>${m.currency} ${m.unit}</small></td><td>${korean(m.accounting)}<small>${m.period}</small></td><td><b>${m.filename}</b> · ${m.page ? `${m.page}쪽` : '쪽수 확인 필요'}<br><q>${m.source_sentence || '원문 근거 없음'}</q></td><td>${korean(m.confidence)}${m.review_reason ? `<small>${m.review_reason}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">추출된 숫자가 없습니다. 검토 필요</td></tr>';
  $('#calcs').innerHTML = a.calculations.items.map((x) => `<div><b>${x.name}</b><strong>${x.value === null ? '검토 필요' : `${x.value}%`}</strong><small>${x.reason}</small></div>`).join('');
  drawChart(a.metrics); $('#notion').disabled = false; $('#previous').disabled = currentIndex === 0; $('#next').disabled = currentIndex === analyses.length - 1; loadTrends(a.meta.ticker);
}

$('#form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#analyze'); const fileCount = event.target.querySelector('input[name="files"]').files.length;
  button.disabled = true; note(`${fileCount}개 파일을 순서대로 분석하고 있습니다. 파일 수에 따라 시간이 걸릴 수 있습니다.`);
  try { const response = await fetch('/api/analyze', { method: 'POST', body: new FormData(event.target) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); analyses = data.analyses || [data]; currentIndex = 0; $('#message').hidden = true; renderCurrent(); $('#review').scrollIntoView({ behavior: 'smooth' }); }
  catch (error) { note(`분석하지 못했습니다: ${error.message}`, true); }
  finally { button.disabled = false; }
});
$('#previous').addEventListener('click', () => { if (currentIndex > 0) { currentIndex -= 1; renderCurrent(); } });
$('#next').addEventListener('click', () => { if (currentIndex < analyses.length - 1) { currentIndex += 1; renderCurrent(); } });
$('#notion').addEventListener('click', async () => {
  if (!confirm('현재 파일의 분석 결과와 출처를 확인했습니다. 이 내용만 Notion에 저장할까요?')) return;
  const button = $('#notion'); button.disabled = true;
  try { const response = await fetch('/api/notion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true, analysis }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); note('현재 파일의 분석 결과를 Notion에 저장했습니다.'); window.open(data.url, '_blank'); }
  catch (error) { note(`Notion에 저장하지 못했습니다: ${error.message}`, true); }
  finally { button.disabled = false; }
});
fetch('/api/health').then((r) => r.json()).then((data) => { $('#health').textContent = data.configured ? '설정 파일 확인됨' : '설정 파일 없음'; }).catch(() => { $('#health').textContent = '연결 확인 필요'; });
