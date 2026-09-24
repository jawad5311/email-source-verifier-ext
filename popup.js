const $ = (selector) => document.querySelector(selector);
let currentState = null;
function send(type, payload = {}) { return chrome.runtime.sendMessage({ type, ...payload }); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]); }
function setError(message = '') { $('#error').textContent = message; }
function render(state) {
  currentState = state;
  const settings = state?.settings || {}, job = state?.job;
  const running = !!job && ['searching','running','paused'].includes(job.status), locked = !!state?.lockedByOtherWindow;
  $('#enabled').checked = settings.enabled !== false; $('#exclusionsEnabled').checked = settings.exclusionsEnabled !== false; $('#partialMatch').checked = settings.partialMatchEnabled === true;
  $('#threshold').value = settings.threshold || job?.threshold || 3; $('#pages').value = settings.pagesPerRun || job?.maxPagesPerRun || 5; $('#activeTabs').value = settings.maxActiveTabs || 5; $('#googleClientId').value = settings.googleClientId || ''; $('#excludedDomains').value = (settings.excludedDomains || []).join('\n');
  $('#start').disabled = settings.enabled === false || locked; $('#start').textContent = running && !job.googlePaused ? 'Pause search' : 'Start search'; $('#stop').hidden = !running;
  $('#status').textContent = locked ? 'Search is running in another window' : (job?.googlePaused ? 'Google search paused — website scans continue' : (job?.status || 'Ready'));
  $('#progress').textContent = job ? `Pages: ${job.pagesVisited || 0}/${job.maxPagesPerRun || settings.pagesPerRun || 5} · Matches: ${(job.matches || []).length}/${job.threshold || settings.threshold || 3} · URLs: ${job.urlsOpened || 0}/${job.urlsScraped || 0} opened/scrapped` : '';
  const sheetLink = $('#sheetLink'); if (job?.sheetUrl) sheetLink.innerHTML = `<a href="${escapeHtml(job.sheetUrl)}" target="_blank">Open ${escapeHtml(job.sheetTitle || 'Google Sheet')}</a>`; else sheetLink.textContent = job?.sheetError || 'No sheet connected for this run.';
  const full = job?.matches || [], partial = job?.partialMatches || [], others = job?.discoveredEmails || [];
  const group = (label, items, type) => !items.length ? `<div class="result-group"><h3>${label} (0)</h3><p class="muted">None found yet.</p></div>` : `<div class="result-group"><h3>${label} (${items.length})</h3>${items.map((item) => `<button class="result-item" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title || item.email || item.url)}"><span>${escapeHtml(type === 'other' ? item.email : (item.title || item.url))}</span><small>${escapeHtml(item.url)}</small></button>`).join('')}</div>`;
  const results = $('#results'); results.classList.toggle('empty', !full.length && !partial.length && !others.length); results.innerHTML = full.length || partial.length || others.length ? group('Full email matches', full, 'full') + group('Partial email matches', partial, 'partial') + group('Other emails found', others, 'other') : 'Your matching URLs and discovered emails will appear here.';
  results.querySelectorAll('.result-item').forEach((button) => button.addEventListener('click', () => send('OPEN_MATCH', { email: job?.email, match: { url: button.dataset.url, title: button.dataset.title } })));
}
async function refresh() { const response = await send('GET_STATE'); if (response) render(response); }
$('#enabled').addEventListener('change', async (event) => { await send('SET_SETTINGS', { settings: { enabled: event.target.checked } }); if (!event.target.checked) await send('STOP_SEARCH'); refresh(); });
$('#exclusionsEnabled').addEventListener('change', (event) => send('SET_SETTINGS', { settings: { exclusionsEnabled: event.target.checked } }).then(refresh));
$('#partialMatch').addEventListener('change', (event) => send('SET_SETTINGS', { settings: { partialMatchEnabled: event.target.checked } }).then(refresh));
$('#threshold').addEventListener('change', (event) => { const threshold = Math.max(1, Math.min(50, Number(event.target.value) || 3)); event.target.value = threshold; send('SET_SETTINGS', { settings: { threshold } }).then(refresh); });
$('#activeTabs').addEventListener('change', (event) => { const maxActiveTabs = Math.max(1, Math.min(50, Number(event.target.value) || 5)); event.target.value = maxActiveTabs; send('SET_SETTINGS', { settings: { maxActiveTabs } }).then(refresh); });
$('#pages').addEventListener('change', (event) => { const pagesPerRun = Math.max(1, Math.min(50, Number(event.target.value) || 5)); event.target.value = pagesPerRun; send('SET_SETTINGS', { settings: { pagesPerRun } }).then(refresh); });
$('#manageExclusions').addEventListener('click', () => { $('#exclusionsPanel').hidden = !$('#exclusionsPanel').hidden; });
$('#saveExclusions').addEventListener('click', async () => { const excludedDomains = $('#excludedDomains').value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean); await send('SET_SETTINGS', { settings: { excludedDomains } }); $('#exclusionsPanel').hidden = true; refresh(); });
$('#connectSheets').addEventListener('click', async () => { setError(); const googleClientId = $('#googleClientId').value.trim(); await send('SET_SETTINGS', { settings: { googleClientId } }); const response = await send('CONNECT_SHEETS'); if (response?.error) setError(response.error); refresh(); });
$('#start').addEventListener('click', async () => { setError(); const email = $('#email').value.trim(); if (!/^\S+@\S+\.\S+$/.test(email)) { setError('Enter a valid email address.'); return; } const running = currentState?.job && ['searching','running','paused'].includes(currentState.job.status); const response = running ? await send('TOGGLE_GOOGLE') : await send('START_SEARCH', { email, threshold: Number($('#threshold').value) }); if (response?.error) setError(response.error); else refresh(); });
$('#stop').addEventListener('click', async () => { await send('STOP_SEARCH'); refresh(); });
$('#reset').addEventListener('click', async () => { await send('RESET_SEARCH'); $('#email').value = ''; setError(); refresh(); });
chrome.runtime.onMessage.addListener((message) => { if (message.type === 'STATE_UPDATED') refresh(); });
refresh();
