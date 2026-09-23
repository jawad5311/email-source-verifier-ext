const $ = (selector) => document.querySelector(selector);
let currentState = null;

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function setError(message = "") { $("#error").textContent = message; }

function render(state) {
  currentState = state;
  const settings = state.settings || {};
  const job = state.job;
  $("#enabled").checked = settings.enabled !== false;
  $("#exclusionsEnabled").checked = settings.exclusionsEnabled !== false;
  $("#threshold").value = settings.threshold || 3;
  $("#pages").value = settings.pagesPerRun || 5;
  $("#activeTabs").value = settings.maxActiveTabs || 5;
  $("#excludedDomains").value = (settings.excludedDomains || []).join("\n");
  const running = job && ["searching", "running"].includes(job.status);
  const locked = state.lockedByOtherWindow === true;
  $("#start").disabled = !settings.enabled || running || locked;
  $("#start").textContent = job?.status === "paused" ? "Continue search" : "Search the web";
  $("#pause").hidden = !running;
  $("#email").disabled = running;
  const status = locked ? "Search is running in another window" : !settings.enabled ? "Extension is off" : !job ? "Ready" : job.status === "searching" ? "Reading Google results…" : job.status === "running" ? "Scanning pages…" : job.status === "paused" ? "Paused — press Search the web to continue" : job.status === "complete" ? "Search complete" : job.status === "stopped" ? "Search stopped" : job.status === "error" ? "Could not complete search" : "Ready";
  $("#status").textContent = status;
  $(".status-dot").className = `status-dot ${running ? "running" : job?.status === "complete" ? "complete" : ""}`;
  $("#progress").textContent = job ? `${job.matches?.length || 0}/${job.threshold || settings.threshold || 3} matches · ${job.pagesVisited || 0} Google pages` : "";
  if (job?.email && !$("#email").value) $("#email").value = job.email;
  const matches = job?.matches || [];
  const results = $("#results");
  if (!matches.length) { results.className = "results empty"; results.textContent = running ? "Scanning pages for an exact match…" : "Your matching URLs will appear here."; return; }
  results.className = "results";
  results.innerHTML = matches.map((match, index) => `<button class="result" data-index="${index}"><strong>${escapeHtml(match.title || match.url)}</strong><span>${escapeHtml(match.url)}</span><span>${escapeHtml(match.snippet || "Match found on this page")}</span></button>`).join("");
  results.querySelectorAll(".result").forEach((button) => button.addEventListener("click", () => send("OPEN_MATCH", { match: matches[Number(button.dataset.index)], email: job.email })));
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }

async function refresh() { const response = await send("GET_STATE"); if (response) render(response); }

$("#enabled").addEventListener("change", async (event) => {
  const enabled = event.target.checked;
  await send("SET_SETTINGS", { settings: { enabled } });
  if (!enabled) await send("STOP_SEARCH");
  refresh();
});
$("#exclusionsEnabled").addEventListener("change", (event) => send("SET_SETTINGS", { settings: { exclusionsEnabled: event.target.checked } }).then(refresh));
$("#threshold").addEventListener("change", (event) => {
  const threshold = Math.max(1, Math.min(50, Number(event.target.value) || 3));
  event.target.value = threshold;
  send("SET_SETTINGS", { settings: { threshold } }).then(refresh);
});
$("#activeTabs").addEventListener("change", (event) => {
  const maxActiveTabs = Math.max(1, Math.min(50, Number(event.target.value) || 5));
  event.target.value = maxActiveTabs;
  send("SET_SETTINGS", { settings: { maxActiveTabs } }).then(refresh);
});
$("#pages").addEventListener("change", (event) => {
  const pagesPerRun = Math.max(1, Math.min(50, Number(event.target.value) || 5));
  event.target.value = pagesPerRun;
  send("SET_SETTINGS", { settings: { pagesPerRun } }).then(refresh);
});
$("#manageExclusions").addEventListener("click", () => { $("#exclusionsPanel").hidden = !$("#exclusionsPanel").hidden; });
$("#saveExclusions").addEventListener("click", async () => { const excludedDomains = $("#excludedDomains").value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean); await send("SET_SETTINGS", { settings: { excludedDomains } }); $("#exclusionsPanel").hidden = true; refresh(); });
$("#start").addEventListener("click", async () => {
  setError();
  const email = $("#email").value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { setError("Enter a valid email address."); return; }
  const response = await send("START_SEARCH", { email, threshold: Number($("#threshold").value) });
  if (response?.error) setError(response.error); else refresh();
});
$("#pause").addEventListener("click", async () => { await send("PAUSE_SEARCH"); refresh(); });
$("#reset").addEventListener("click", async () => { await send("RESET_SEARCH"); $("#email").value = ""; setError(); refresh(); });
chrome.runtime.onMessage.addListener((message) => { if (message.type === "STATE_UPDATED") refresh(); });
refresh();

