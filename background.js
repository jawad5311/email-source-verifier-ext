const DEFAULT_SETTINGS = {
  enabled: true,
  exclusionsEnabled: true,
  excludedDomains: [
    "rocketreach.co",
    "contactout.com",
    "apollo.io",
    "lusha.com",
    "zoominfo.com",
    "hunter.io"
  ],
  threshold: 3,
  pagesPerRun: 5,
  maxActiveTabs: 5,
  partialMatchEnabled: false,
  googleClientId: ""
};

const JOB_KEY = "esvJob";
const SETTINGS_KEY = "esvSettings";
const SEEN_URLS_KEY = "esvSeenUrls";
const GOOGLE_TOKEN_KEY = "esvGoogleToken";
let sheetWriteChain = Promise.resolve();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let schedulerRunning = false;

async function getSettings() {
  const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

async function getJob() {
  const { [JOB_KEY]: job } = await chrome.storage.local.get(JOB_KEY);
  return job || null;
}

async function saveJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
  notifyPopup();
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATED" }).catch(() => {});
}

async function getActiveWindow() {
  return chrome.windows.getLastFocused({ populate: false });
}

async function windowExists(windowId) {
  if (windowId === undefined || windowId === null) return false;
  const windows = await chrome.windows.getAll({ populate: false });
  return windows.some((item) => item.id === windowId);
}

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

function isExcluded(url, settings) {
  if (!settings.exclusionsEnabled) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return (settings.excludedDomains || [])
      .map(normalizeDomain)
      .filter(Boolean)
      .some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return true;
  }
}

function isLinkedIn(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

function siteHost(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "unknown"; }
}

function normalizeScanUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    const removable = /^(utm_|gclid$|fbclid$|msclkid$|dclid$|mc_cid$|mc_eid$|ref$|referrer$|source$)/i;
    for (const key of [...url.searchParams.keys()]) if (removable.test(key)) url.searchParams.delete(key);
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [key, value] of params) url.searchParams.append(key, value);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch { return ""; }
}

function cleanGoogleUrl(raw) {
  try {
    const url = new URL(raw, "https://www.google.com");
    if (url.hostname.endsWith("google.com") && url.pathname === "/url") {
      return normalizeScanUrl(url.searchParams.get("q") || url.searchParams.get("url") || "");
    }
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.hostname.endsWith("google.com")) return "";
    return normalizeScanUrl(url.href);
  } catch {
    return "";
  }
}

async function executeInTab(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.[0]?.result;
}

async function extractGoogleLinks() {
  const links = [...document.querySelectorAll("a[href]")].map((anchor) => anchor.href).filter(Boolean);
  const hasNext = [...document.querySelectorAll("a")].some((anchor) => /next|more results/i.test(`${anchor.textContent} ${anchor.getAttribute("aria-label") || ""}`));
  return { links, hasNext };
}

async function scanPageForEmail(email, partialEnabled = false) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deobfuscate = (value) => String(value || "")
    .toLowerCase()
    .replace(/&#(?:64|x40);|&commat;/gi, "@")
    .replace(/&#(?:46|x2e);|&period;/gi, ".")
    .replace(/\s*(?:\[at\]|\(at\)|\{at\}|\bat\b)\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b)\s*/gi, ".")
    .replace(/\s*@\s*/g, "@")
    .replace(/\s*\.\s*/g, ".");
  const canonicalize = (value) => deobfuscate(value).replace(/\s+/g, "");
  const localPart = String(email).split("@")[0].toLowerCase();
  let lastHeight = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await wait(220);
    const height = document.documentElement.scrollHeight;
    if (height === lastHeight && pass > 2) break;
    lastHeight = height;
  }

  const text = document.body?.innerText || "";
  const html = document.documentElement?.innerHTML || "";
  const searchable = deobfuscate(`${text}\n${html}`);
  const emails = [...new Set((searchable.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
    .map((value) => value.toLowerCase().replace(/\s+/g, ""))
    .filter((value) => value.length <= 254))];
  const found = canonicalize(searchable).includes(needle);
  const partialFound = !found && partialEnabled && localPart.length >= 3 && searchable.toLowerCase().includes(localPart);
  let snippet = "";
  let matchedElement = null;

  if (found && document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (canonicalize(node.nodeValue || "").includes(needle)) {
        matchedElement = node.parentElement;
        break;
      }
    }
    const source = canonicalize(text);
    const index = source.indexOf(needle);
    snippet = index >= 0
      ? text.slice(Math.max(0, index - 110), Math.min(text.length, index + email.length + 180)).replace(/\s+/g, " ").trim()
      : `The email appears in the page source.`;
    if (matchedElement) {
      matchedElement.scrollIntoView({ behavior: "instant", block: "center" });
      matchedElement.style.outline = "3px solid #ffb84d";
      matchedElement.style.backgroundColor = "#fff3d6";
      matchedElement.setAttribute("data-esv-match", "true");
      const badge = document.createElement("div");
      badge.textContent = "Email Source Verifier: match found";
      badge.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;padding:10px 14px;border-radius:10px;background:#152238;color:#fff;font:600 13px system-ui;box-shadow:0 8px 30px #0003";
      document.body.appendChild(badge);
    }
  }
  return { found, partialFound, emails, title: document.title || "Untitled page", snippet };
}

async function highlightEmailOnPage(email) {
  const needle = email.toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if ((node.nodeValue || "").toLowerCase().includes(needle)) {
      const element = node.parentElement;
      element.scrollIntoView({ behavior: "instant", block: "center" });
      element.style.outline = "3px solid #ffb84d";
      element.style.backgroundColor = "#fff3d6";
      return true;
    }
  }
  return false;
}

async function scrollTabToBottom(tabId) {
  await executeInTab(tabId, async () => {
    for (let pass = 0; pass < 10; pass += 1) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
  }, []).catch(() => {});
}

async function showTabIssue(tabId, message, duration = 10000) {
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await executeInTab(tabId, (text, timeout) => {
    const banner = document.createElement("div");
    banner.textContent = text;
    banner.style.cssText = "position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);max-width:520px;padding:14px 18px;border-radius:12px;background:#8b2f2f;color:#fff;font:700 14px system-ui;box-shadow:0 8px 30px #0005;text-align:center";
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), timeout);
  }, [message, duration]).catch(() => {});
  await delay(duration);
}

async function detectPageIssue() {
  const body = (document.body?.innerText || "").toLowerCase();
  if (/access denied|403 forbidden|404 not found|this site can.t be reached|network error|something went wrong|temporarily unavailable|enable javascript to continue/.test(body)) return "This website reported an access or loading issue. Scroll manually or resolve the page issue.";
  return "";
}

async function detectHumanVerification() {
  const body = (document.body?.innerText || "").toLowerCase();
  return /verify you are human|human verification|unusual traffic|captcha|recaptcha|i'm not a robot|are you a robot|security check/.test(body);
}

async function updateGoogleProgress(tabId, progress) {
  await executeInTab(tabId, (value) => {
    let panel = document.getElementById("esv-progress");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "esv-progress";
      panel.style.cssText = "position:fixed;z-index:2147483647;right:18px;bottom:18px;width:280px;padding:12px 14px;border-radius:12px;background:#152238;color:#fff;font:600 13px system-ui;box-shadow:0 8px 30px #0004";
      document.body.appendChild(panel);
    }
    panel.innerHTML = `<strong>Email Source Verifier — ${value.status}</strong><br><strong>Pages: ${value.pages}/${value.maxPages} · Matches: ${value.matches}/${value.threshold}</strong><br>URLs: ${value.opened}/${value.scraped} opened/total-urls-scrapped`;
    panel.style.whiteSpace = "pre-line";
  }, [progress]).catch(() => {});
}

async function waitForVerification(tabId, job) {
  const needsVerification = await executeInTab(tabId, detectHumanVerification, []).catch(() => false);
  if (!needsVerification) return true;
  job.verifyingTabId = tabId;
  job.verificationMessage = "Human verification required — complete it in the focused tab.";
  await saveJob(job);
  const verificationTab = await chrome.tabs.get(tabId).catch(() => null);
  if (verificationTab?.windowId !== undefined) await chrome.windows.update(verificationTab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await executeInTab(tabId, (text) => {
    const banner = document.createElement("div");
    banner.textContent = text;
    banner.style.cssText = "position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);padding:14px 18px;border-radius:12px;background:#8b2f2f;color:#fff;font:700 14px system-ui;box-shadow:0 8px 30px #0005";
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 12000);
  }, ["Human verification required — complete it in this tab."]).catch(() => {});
  await updateGoogleProgress(job.searchTabId, { status: "Waiting for human verification", pages: job.pagesVisited || 0, maxPages: job.maxPagesPerRun, matches: job.matches.length, threshold: job.threshold, opened: job.urlsOpened || 0, scraped: job.urlsScraped || 0 });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await delay(1500);
    const stillBlocked = await executeInTab(tabId, detectHumanVerification, []).catch(() => true);
    if (!stillBlocked) {
      job.verifyingTabId = null;
      job.verificationMessage = "";
      await saveJob(job);
      return true;
    }
  }
  return false;
}

async function closeJobTabs(job) {
  const ids = new Set((job.tabs || []).map((item) => item.tabId).filter(Boolean));
  await Promise.all([...ids].map(async (id) => {
    await scrollTabToBottom(id);
    await chrome.tabs.remove(id).catch(() => {});
  }));
}

async function finishJob(job, status = "complete") {
  job.status = status;
  job.finishedAt = Date.now();
  await saveJob(job);
  await closeJobTabs(job);
}

async function startNextLinkedIn() {
  const job = await getJob();
  if (!job || job.status !== "running" || job.matches.length >= job.threshold || job.linkedinActive) return;
  const next = job.linkedinQueue.shift();
  if (!next) {
    if ((job.pendingNonLinkedIn || 0) === 0) await finishJob(job);
    else await saveJob(job);
    return;
  }
  job.linkedinActive = true;
  await saveJob(job);
  const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: job.ownerWindowId });
  const liveJob = await getJob();
  if (!liveJob || liveJob.status !== "running") {
    await chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  liveJob.tabs.push({ tabId: tab.id, url: next, kind: "linkedin", started: false });
  await saveJob(liveJob);
  await chrome.tabs.update(tab.id, { url: next });
}

async function startQueuedHost(host) {
  const job = await getJob();
  if (!job || !["searching", "running"].includes(job.status) || job.matches.length >= job.threshold) return;
  const settings = await getSettings();
  const maxActiveTabs = Math.max(1, Math.min(50, Number(settings.maxActiveTabs) || 5));
  if ((job.tabs || []).length >= maxActiveTabs) return;
  const queue = job.hostQueues?.[host] || [];
  if (!queue.length || job.activeHosts?.includes(host)) return;
  const next = queue.shift();
  job.activeHosts = [...new Set([...(job.activeHosts || []), host])];
  job.hostQueues[host] = queue;
  await saveJob(job);
  const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: job.ownerWindowId });
  const liveJob = await getJob();
  if (!liveJob || !["searching", "running"].includes(liveJob.status)) { await chrome.tabs.remove(tab.id).catch(() => {}); return; }
  liveJob.tabs.push({ tabId: tab.id, url: next, host, kind: isLinkedIn(next) ? "linkedin" : "other", started: false });
  liveJob.urlsOpened = (liveJob.urlsOpened || 0) + 1;
  await saveJob(liveJob);
  await chrome.tabs.update(tab.id, { url: next });
}

async function scheduleHostQueues() {
  let job = await getJob();
  if (!job) return;
  for (const host of Object.keys(job.hostQueues || {})) {
    job = await getJob();
    const settings = await getSettings();
    const maxActiveTabs = Math.max(1, Math.min(50, Number(settings.maxActiveTabs) || 5));
    if ((job.tabs || []).length >= maxActiveTabs) break;
    await startQueuedHost(host);
  }
}

async function scanLoadedTab(tabId) {
  const job = await getJob();
  if (!job || !["searching", "running"].includes(job.status)) return;
  const record = (job.tabs || []).find((item) => item.tabId === tabId);
  if (!record || record.started) return;
  record.started = true;
  await saveJob(job);

  if (!(await waitForVerification(tabId, job))) {
    await showTabIssue(tabId, "Verification did not complete. Please scroll manually or finish the verification.", 10000);
    await scrollTabToBottom(tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    return;
}

  let result = { found: false, partialFound: false, emails: [], title: "Untitled page", snippet: "" };
  let issueMessage = await executeInTab(tabId, detectPageIssue, []).catch(() => "");
  try {
    const scanSettings = await getSettings();
    result = await executeInTab(tabId, scanPageForEmail, [job.email, scanSettings.partialMatchEnabled === true]);
  } catch {
    issueMessage = "This website could not be scanned. Scroll manually or check the page for an access issue.";
    result = { found: false, partialFound: false, emails: [], title: "Page could not be scanned", snippet: "" };
  }

  if (issueMessage) await showTabIssue(tabId, issueMessage, 10000);
  await scrollTabToBottom(tabId);
  const current = await getJob();
  if (!current || !["searching", "running", "paused"].includes(current.status)) {
    await chrome.tabs.remove(tabId).catch(() => {});
    return;
  }
  const currentRecord = (current.tabs || []).find((item) => item.tabId === tabId);
  current.urlsScraped = (current.urlsScraped || 0) + 1;
  if (currentRecord && result?.found && current.matches.length < current.threshold) {
    current.matches.push({ url: currentRecord.url, title: result.title, snippet: result.snippet, foundAt: Date.now() });
  } else if (currentRecord && result?.partialFound) {
    current.partialMatches = current.partialMatches || [];
    if (!current.partialMatches.some((item) => item.url === currentRecord.url)) current.partialMatches.push({ url: currentRecord.url, title: result.title, snippet: result.snippet, foundAt: Date.now() });
  }
  current.discoveredEmails = current.discoveredEmails || [];
  for (const foundEmail of (result?.emails || [])) {
    if (foundEmail.toLowerCase() === current.email.toLowerCase()) continue;
    if (!current.discoveredEmails.some((item) => item.email === foundEmail && item.url === currentRecord?.url)) current.discoveredEmails.push({ email: foundEmail, url: currentRecord?.url, title: result.title, foundAt: Date.now() });
  }
  const sheetRows = [];
  if (currentRecord && result?.found) sheetRows.push(["Full match", current.email, current.email, currentRecord.url, result.title, result.snippet, new Date().toISOString()]);
  if (currentRecord && result?.partialFound && !result?.found) sheetRows.push(["Partial match", current.email, current.email.split("@")[0], currentRecord.url, result.title, result.snippet, new Date().toISOString()]);
  for (const foundEmail of (result?.emails || [])) {
    if (foundEmail.toLowerCase() !== current.email.toLowerCase()) sheetRows.push(["Other email", current.email, foundEmail, currentRecord?.url || "", result.title, "", new Date().toISOString()]);
  }
  await appendSheetRows(current, sheetRows);
  await updateGoogleProgress(current.searchTabId, { status: "Scanning pages", pages: current.pagesVisited || 0, maxPages: current.maxPagesPerRun, matches: current.matches.length, threshold: current.threshold, opened: current.urlsOpened || 0, scraped: current.urlsScraped || 0 });
  current.tabs = (current.tabs || []).filter((item) => item.tabId !== tabId);
  if (currentRecord?.host) {
    current.activeHosts = (current.activeHosts || []).filter((host) => host !== currentRecord.host);
    current.pendingUrls = Math.max(0, (current.pendingUrls || 0) - 1);
  }
  await chrome.tabs.remove(tabId).catch(() => {});

  if (current.matches.length >= current.threshold) {
    await finishJob(current);
    return;
  }
  await saveJob(current);
  await scheduleHostQueues();
  const remaining = Object.values(current.hostQueues || {}).reduce((sum, queue) => sum + queue.length, 0);
  if (current.pendingUrls === 0 && remaining === 0 && !(current.activeHosts || []).length && current.searchExhausted) await finishJob(current);
}

async function processSearchTab(tabId) {
  const job = await getJob();
  if (!job || !["searching", "running"].includes(job.status) || job.searchTabId !== tabId) return;
  let pageData = { links: [], hasNext: false };
  try {
    pageData = await executeInTab(tabId, extractGoogleLinks);
  } catch {
    job.status = "error";
    job.error = "Google results could not be read.";
    await saveJob(job);
    return;
  }
  const settings = await getSettings();
  const urls = [...new Set((pageData?.links || []).map(cleanGoogleUrl).filter(Boolean))]
    .filter((url) => !isExcluded(url, settings));
  const stored = await chrome.storage.local.get(SEEN_URLS_KEY);
  const rememberedUrls = stored[SEEN_URLS_KEY] || [];
  const freshUrls = urls.filter((url) => !(job.seenUrls || []).includes(url) && !rememberedUrls.includes(url));
  job.seenUrls = [...(job.seenUrls || []), ...freshUrls];
  await chrome.storage.local.set({ [SEEN_URLS_KEY]: [...new Set([...rememberedUrls, ...freshUrls])].slice(-5000) });
  job.candidates = [...(job.candidates || []), ...freshUrls];
  job.hostQueues = job.hostQueues || {};
  for (const url of freshUrls) {
    const host = siteHost(url);
    job.hostQueues[host] = [...(job.hostQueues[host] || []), url];
  }
  job.pendingUrls = (job.pendingUrls || 0) + freshUrls.length;
  job.pagesVisited = (job.pagesVisited || 0) + 1;
  job.pagesThisRun = (job.pagesThisRun || 0) + 1;
  job.searchExhausted = !pageData?.hasNext;
  await saveJob(job);
  await scheduleHostQueues();
  const liveJob = await getJob();
  if (liveJob.matches.length >= liveJob.threshold) { await finishJob(liveJob); return; }
  if (liveJob.pagesThisRun >= liveJob.maxPagesPerRun || liveJob.searchExhausted) {
    liveJob.status = "running";
    liveJob.googlePaused = !liveJob.searchExhausted;
    liveJob.nextSearchUrl = liveJob.searchExhausted ? null : `${liveJob.baseSearchUrl}&start=${liveJob.pagesVisited * 10}`;
    await saveJob(liveJob);
    await updateGoogleProgress(tabId, { status: liveJob.searchExhausted ? "Scanning final page" : "Paused — press Start search to continue Google pages", pages: liveJob.pagesVisited, maxPages: liveJob.maxPagesPerRun, matches: liveJob.matches.length, threshold: liveJob.threshold, opened: liveJob.urlsOpened || 0, scraped: liveJob.urlsScraped || 0 });
    if (liveJob.searchExhausted && liveJob.pendingUrls === 0) await finishJob(liveJob);
    return;
  }
  if (liveJob.googlePaused) return;
  liveJob.status = "searching";
  liveJob.nextSearchUrl = `${liveJob.baseSearchUrl}&start=${liveJob.pagesVisited * 10}`;
  await saveJob(liveJob);
  const pageDelay = 4000 + Math.floor(Math.random() * 4001);
  await updateGoogleProgress(tabId, { status: `Waiting ${Math.ceil(pageDelay / 1000)}s before next Google page`, pages: liveJob.pagesVisited, maxPages: liveJob.maxPagesPerRun, matches: liveJob.matches.length, threshold: liveJob.threshold, opened: liveJob.urlsOpened || 0, scraped: liveJob.urlsScraped || 0 });
  await delay(pageDelay);
  const beforeNavigation = await getJob();
  if (!beforeNavigation || beforeNavigation.status !== "searching" || beforeNavigation.googlePaused) return;
  await chrome.tabs.update(tabId, { url: liveJob.nextSearchUrl }).catch(() => {});
}

async function getGoogleAccessToken(interactive = true) {
  const settings = await getSettings();
  if (!settings.googleClientId) throw new Error("Add a Google OAuth client ID to enable Sheets export.");
  const stored = await chrome.storage.local.get(GOOGLE_TOKEN_KEY);
  if (stored[GOOGLE_TOKEN_KEY]?.accessToken && stored[GOOGLE_TOKEN_KEY].expiresAt > Date.now() + 60000) return stored[GOOGLE_TOKEN_KEY].accessToken;
  const redirect = chrome.identity.getRedirectURL("sheets");
  const params = new URLSearchParams({ client_id: settings.googleClientId, response_type: "token", redirect_uri: redirect, scope: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets", prompt: "select_account" });
  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + params, interactive });
  const values = new URLSearchParams(new URL(responseUrl).hash.replace(/^#/, ""));
  const accessToken = values.get("access_token");
  if (!accessToken) throw new Error("Google authorization did not return an access token.");
  await chrome.storage.local.set({ [GOOGLE_TOKEN_KEY]: { accessToken, expiresAt: Date.now() + 3500000 } });
  return accessToken;
}

async function googleApi(path, init = {}, interactive = false) {
  const token = await getGoogleAccessToken(interactive);
  const headers = { "Content-Type": "application/json", ...(init.headers || {}), Authorization: "Bearer " + token };
  const response = await fetch("https://www.googleapis.com" + path, { ...init, headers });
  if (response.status === 401) { await chrome.storage.local.remove(GOOGLE_TOKEN_KEY); throw new Error("Google authorization expired. Connect Sheets again."); }
  if (!response.ok) throw new Error("Google Sheets request failed (" + response.status + ").");
  return response.json();
}

async function ensureSheetForJob(job, interactive = false) {
  if (job.sheetId) return job;
  const settings = await getSettings();
  if (!settings.googleClientId) return job;
  const baseName = job.email + " - v";
  for (let version = 1; version <= 1000; version += 1) {
    const title = baseName + version;
    const query = encodeURIComponent("name = \"" + title + "\" and mimeType = \"application/vnd.google-apps.spreadsheet\" and trashed = false");
    const found = await googleApi("/drive/v3/files?q=" + query + "&pageSize=1&fields=files(id,name)", {}, interactive);
    if (!found.files?.length) {
      const created = await googleApi("/sheets/v4/spreadsheets", { method: "POST", body: JSON.stringify({ properties: { title } }) }, interactive);
      job.sheetId = created.spreadsheetId;
      job.sheetTitle = title;
      job.sheetUrl = "https://docs.google.com/spreadsheets/d/" + created.spreadsheetId + "/edit";
      await googleApi("/sheets/v4/spreadsheets/" + created.spreadsheetId + "/values/Sheet1!A1:G1?valueInputOption=USER_ENTERED", { method: "PUT", body: JSON.stringify({ values: [["Type", "Provided email", "Found email", "URL", "Title", "Snippet", "Found at"]] }) }, interactive);
      await saveJob(job);
      return job;
    }
  }
  throw new Error("Could not find an available Google Sheet version.");
}

async function appendSheetRows(job, rows) {
  if (!job.sheetId || !rows.length) return;
  sheetWriteChain = sheetWriteChain.then(() => googleApi("/sheets/v4/spreadsheets/" + job.sheetId + "/values/Sheet1!A:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", { method: "POST", body: JSON.stringify({ values: rows }) }, false));
  await sheetWriteChain.catch((error) => { job.sheetError = error.message; saveJob(job); });
}
async function clearSeenUrls() {
  await chrome.storage.local.remove(SEEN_URLS_KEY);
}

async function toggleGoogleSearch() {
  const job = await getJob();
  if (!job || !["searching", "running", "paused"].includes(job.status)) return job;
  job.googlePaused = !job.googlePaused;
  if (job.googlePaused) {
    job.pausedAt = Date.now();
    await saveJob(job);
    return job;
  }
  job.status = "running";
  await saveJob(job);
  if (job.nextSearchUrl && job.searchTabId) {
    try { await chrome.tabs.update(job.searchTabId, { active: true, url: job.nextSearchUrl }); } catch {}
  }
  return job;
}

async function resetJob() {
  const job = await getJob();
  if (job) {
    job.status = "resetting";
    await saveJob(job);
    await closeJobTabs(job);
    if (job.searchTabId) {
      await scrollTabToBottom(job.searchTabId);
      await chrome.tabs.remove(job.searchTabId).catch(() => {});
    }
  }
  await clearSeenUrls();
  await chrome.storage.local.remove(JOB_KEY);
  notifyPopup();
  return null;
}

async function stopJob() {
  const job = await getJob();
  if (!job || !["searching", "running", "paused"].includes(job.status)) return job;
  job.status = "stopped";
  job.finishedAt = Date.now();
  await clearSeenUrls();
  await saveJob(job);
  await closeJobTabs(job);
  if (job.searchTabId) {
    await scrollTabToBottom(job.searchTabId);
    await chrome.tabs.remove(job.searchTabId).catch(() => {});
  }
  return job;
}

async function startSearch(email, requestedThreshold) {
  const currentWindow = await getActiveWindow();
  const settings = await getSettings();
  if (!settings.enabled) throw new Error("The extension is turned off.");
  const existing = await getJob();
  if (existing && existing.ownerWindowId !== currentWindow.id && ["searching", "running", "paused"].includes(existing.status)) {
    if (await windowExists(existing.ownerWindowId)) throw new Error("This search is already running in another browser window.");
    await stopJob();
  }
  if (existing && existing.email.toLowerCase() === email.trim().toLowerCase() && existing.status === "paused" && existing.nextSearchUrl) {
    existing.status = "searching";
    existing.pagesThisRun = 0;
    existing.maxPagesPerRun = Math.max(1, Math.min(50, Number(settings.pagesPerRun) || 5));
    await saveJob(existing);
    try {
      await chrome.tabs.update(existing.searchTabId, { active: true, url: existing.nextSearchUrl });
    } catch {
      const replacement = await chrome.tabs.create({ url: "about:blank", active: true, windowId: currentWindow.id });
      existing.searchTabId = replacement.id;
      await saveJob(existing);
      await chrome.tabs.update(replacement.id, { url: existing.nextSearchUrl }).catch(() => {});
    }
    return existing;
  }
  await stopJob();
  const threshold = Math.max(1, Math.min(50, Number(requestedThreshold) || settings.threshold || 3));
  const maxPagesPerRun = Math.max(1, Math.min(50, Number(settings.pagesPerRun) || 5));
  const job = {
    id: crypto.randomUUID(), email: email.trim(), threshold, status: "searching", matches: [], partialMatches: [], discoveredEmails: [], candidates: [],
    tabs: [], hostQueues: {}, activeHosts: [], pendingUrls: 0, urlsOpened: 0, urlsScraped: 0, seenUrls: [], pagesVisited: 0, pagesThisRun: 0,
    maxPagesPerRun, searchExhausted: false, ownerWindowId: currentWindow.id, startedAt: Date.now()
  };
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(job.email)}`;
  const searchTab = await chrome.tabs.create({ url: "about:blank", active: true, windowId: currentWindow.id });
  job.searchTabId = searchTab.id;
  job.searchUrl = searchUrl;
  job.baseSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(job.email)}`;
  await ensureSheetForJob(job, true).catch((error) => { job.sheetError = error.message; saveJob(job); });
  await saveJob(job);
  await chrome.tabs.update(searchTab.id, { url: searchUrl });
  return job;
}

async function openMatch(match, email, windowId) {
  const tab = await chrome.tabs.create({ url: "about:blank", active: true, windowId });
  const listener = async (tabId, changeInfo, updatedTab) => {
    if (tabId !== tab.id || changeInfo.status !== "complete") return;
    if (!(changeInfo.url || updatedTab?.url || "").startsWith("http")) return;
    chrome.tabs.onUpdated.removeListener(listener);
    await delay(250);
    await executeInTab(tab.id, scanPageForEmail, [email]).catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(listener);
  await chrome.tabs.update(tab.id, { url: match.url });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  getJob().then((job) => {
    if (!job) return;
    if (job.ownerWindowId && tab?.windowId !== job.ownerWindowId) return;
    const currentUrl = changeInfo.url || tab?.url || "";
    if (job.status === "searching" && job.searchTabId === tabId && currentUrl.startsWith("https://www.google.com/search")) processSearchTab(tabId);
    else if (["searching", "running", "paused"].includes(job.status)) {
      const record = (job.tabs || []).find((item) => item.tabId === tabId);
      if (record && currentUrl.startsWith("http")) scanLoadedTab(tabId);
    }
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await getJob();
  if (!job || !["searching", "running"].includes(job.status)) return;
  const record = (job.tabs || []).find((item) => item.tabId === tabId);
  if (!record) return;
  job.tabs = job.tabs.filter((item) => item.tabId !== tabId);
  job.activeHosts = (job.activeHosts || []).filter((host) => host !== record.host);
  job.pendingUrls = Math.max(0, (job.pendingUrls || 0) - 1);
  await saveJob(job);
  await scheduleHostQueues();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "GET_STATE") {
        const settings = await getSettings();
        const job = await getJob();
        const currentWindow = await getActiveWindow();
        sendResponse({ settings, job, lockedByOtherWindow: !!(job?.ownerWindowId && job.ownerWindowId !== currentWindow.id && ["searching", "running", "paused"].includes(job.status)) });
      } else if (message.type === "SET_SETTINGS") {
        const current = await getSettings();
        const next = { ...current, ...message.settings };
        next.excludedDomains = [...new Set((next.excludedDomains || []).map(normalizeDomain).filter(Boolean))];
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        sendResponse({ settings: next });
      } else if (message.type === "CONNECT_SHEETS") {
        await getGoogleAccessToken(true);
        sendResponse({ ok: true });
      } else if (message.type === "START_SEARCH") {
        sendResponse({ job: await startSearch(message.email, message.threshold) });
      } else if (message.type === "TOGGLE_GOOGLE") {
        sendResponse({ job: await toggleGoogleSearch() });
      } else if (message.type === "RESET_SEARCH") {
        sendResponse({ job: await resetJob() });
      } else if (message.type === "STOP_SEARCH") {
        sendResponse({ job: await stopJob() });
      } else if (message.type === "OPEN_MATCH") {
        const job = await getJob();
        await openMatch(message.match, job?.email || message.email, job?.ownerWindowId);
        sendResponse({ ok: true });
      }
    } catch (error) {
      sendResponse({ error: error.message || "Something went wrong." });
    }
  })();
  return true;
});























