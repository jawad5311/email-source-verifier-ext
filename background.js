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
  maxActiveTabs: 5
};

const JOB_KEY = "esvJob";
const SETTINGS_KEY = "esvSettings";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function cleanGoogleUrl(raw) {
  try {
    const url = new URL(raw, "https://www.google.com");
    if (url.hostname.endsWith("google.com") && url.pathname === "/url") {
      return url.searchParams.get("q") || url.searchParams.get("url") || "";
    }
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.hostname.endsWith("google.com")) return "";
    return url.href;
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

async function scanPageForEmail(email) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const canonicalize = (value) => String(value || "")
    .toLowerCase()
    .replace(/&#(?:64|x40);|&commat;/gi, "@")
    .replace(/&#(?:46|x2e);|&period;/gi, ".")
    .replace(/\s*(?:\[at\]|\(at\)|\{at\}|\bat\b)\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b)\s*/gi, ".")
    .replace(/\s*@\s*/g, "@")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, "");
  const needle = canonicalize(email);
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
  const found = canonicalize(text).includes(needle) || canonicalize(html).includes(needle);
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
  return { found, title: document.title || "Untitled page", snippet };
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
    panel.textContent = `Email Source Verifier — ${value.status}\nPages: ${value.pages}/${value.maxPages} · Matches: ${value.matches}/${value.threshold}`;
    panel.style.whiteSpace = "pre-line";
  }, [progress]).catch(() => {});
}

async function waitForVerification(tabId, job) {
  const needsVerification = await executeInTab(tabId, detectHumanVerification, []).catch(() => false);
  if (!needsVerification) return true;
  job.verifyingTabId = tabId;
  job.verificationMessage = "Human verification required — complete it in the focused tab.";
  await saveJob(job);
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await updateGoogleProgress(job.searchTabId, { status: "Waiting for human verification", pages: job.pagesVisited || 0, maxPages: job.maxPagesPerRun, matches: job.matches.length, threshold: job.threshold });
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
  await Promise.all([...ids].map((id) => chrome.tabs.remove(id).catch(() => {})));
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
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
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
  if (!job || !["searching", "running", "paused"].includes(job.status) || job.matches.length >= job.threshold) return;
  const settings = await getSettings();
  const maxActiveTabs = Math.max(1, Math.min(50, Number(settings.maxActiveTabs) || 5));
  if ((job.tabs || []).length >= maxActiveTabs) return;
  const queue = job.hostQueues?.[host] || [];
  if (!queue.length || job.activeHosts?.includes(host)) return;
  const next = queue.shift();
  job.activeHosts = [...new Set([...(job.activeHosts || []), host])];
  job.hostQueues[host] = queue;
  await saveJob(job);
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const liveJob = await getJob();
  if (!liveJob || !["searching", "running", "paused"].includes(liveJob.status)) { await chrome.tabs.remove(tab.id).catch(() => {}); return; }
  liveJob.tabs.push({ tabId: tab.id, url: next, host, kind: isLinkedIn(next) ? "linkedin" : "other", started: false });
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
  if (!job || !["searching", "running", "paused"].includes(job.status)) return;
  const record = (job.tabs || []).find((item) => item.tabId === tabId);
  if (!record || record.started) return;
  record.started = true;
  await saveJob(job);

  if (!(await waitForVerification(tabId, job))) {
    await chrome.tabs.remove(tabId).catch(() => {});
    return;
  }

  let result = { found: false, title: "Untitled page", snippet: "" };
  try {
    result = await executeInTab(tabId, scanPageForEmail, [job.email]);
  } catch {
    result = { found: false, title: "Page could not be scanned", snippet: "" };
  }

  const current = await getJob();
  if (!current || !["searching", "running", "paused"].includes(current.status)) {
    await chrome.tabs.remove(tabId).catch(() => {});
    return;
  }
  const currentRecord = (current.tabs || []).find((item) => item.tabId === tabId);
  if (currentRecord && result?.found && current.matches.length < current.threshold) {
    current.matches.push({ url: currentRecord.url, title: result.title, snippet: result.snippet, foundAt: Date.now() });
  }
  await updateGoogleProgress(current.searchTabId, { status: "Scanning pages", pages: current.pagesVisited || 0, maxPages: current.maxPagesPerRun, matches: current.matches.length, threshold: current.threshold });
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
  const freshUrls = urls.filter((url) => !(job.seenUrls || []).includes(url));
  job.seenUrls = [...(job.seenUrls || []), ...freshUrls];
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
    liveJob.status = liveJob.searchExhausted ? "running" : "paused";
    liveJob.nextSearchUrl = liveJob.searchExhausted ? null : `${liveJob.baseSearchUrl}&start=${liveJob.pagesVisited * 10}`;
    await saveJob(liveJob);
    await updateGoogleProgress(tabId, { status: liveJob.searchExhausted ? "Scanning final page" : "Paused — press Search the web to continue", pages: liveJob.pagesVisited, maxPages: liveJob.maxPagesPerRun, matches: liveJob.matches.length, threshold: liveJob.threshold });
    if (liveJob.searchExhausted && liveJob.pendingUrls === 0) await finishJob(liveJob);
    return;
  }
  liveJob.status = "searching";
  liveJob.nextSearchUrl = `${liveJob.baseSearchUrl}&start=${liveJob.pagesVisited * 10}`;
  await saveJob(liveJob);
  const pageDelay = 4000 + Math.floor(Math.random() * 4001);
  await updateGoogleProgress(tabId, { status: `Waiting ${Math.ceil(pageDelay / 1000)}s before next Google page`, pages: liveJob.pagesVisited, maxPages: liveJob.maxPagesPerRun, matches: liveJob.matches.length, threshold: liveJob.threshold });
  await delay(pageDelay);
  const beforeNavigation = await getJob();
  if (!beforeNavigation || beforeNavigation.status !== "searching") return;
  await chrome.tabs.update(tabId, { url: liveJob.nextSearchUrl });
}

async function stopJob() {
  const job = await getJob();
  if (!job || !["searching", "running"].includes(job.status)) return job;
  job.status = "stopped";
  job.finishedAt = Date.now();
  await saveJob(job);
  await closeJobTabs(job);
  return job;
}

async function startSearch(email, requestedThreshold) {
  const settings = await getSettings();
  if (!settings.enabled) throw new Error("The extension is turned off.");
  const existing = await getJob();
  if (existing && existing.email.toLowerCase() === email.trim().toLowerCase() && existing.status === "paused" && existing.nextSearchUrl) {
    existing.status = "searching";
    existing.pagesThisRun = 0;
    existing.maxPagesPerRun = Math.max(1, Math.min(50, Number(settings.pagesPerRun) || 5));
    await saveJob(existing);
    await chrome.tabs.update(existing.searchTabId, { active: true, url: existing.nextSearchUrl });
    return existing;
  }
  await stopJob();
  const threshold = Math.max(1, Math.min(50, Number(requestedThreshold) || settings.threshold || 3));
  const maxPagesPerRun = Math.max(1, Math.min(50, Number(settings.pagesPerRun) || 5));
  const job = {
    id: crypto.randomUUID(), email: email.trim(), threshold, status: "searching", matches: [], candidates: [],
    tabs: [], hostQueues: {}, activeHosts: [], pendingUrls: 0, seenUrls: [], pagesVisited: 0, pagesThisRun: 0,
    maxPagesPerRun, searchExhausted: false, startedAt: Date.now()
  };
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(job.email)}`;
  const searchTab = await chrome.tabs.create({ url: "about:blank", active: true });
  job.searchTabId = searchTab.id;
  job.searchUrl = searchUrl;
  job.baseSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(job.email)}`;
  await saveJob(job);
  await chrome.tabs.update(searchTab.id, { url: searchUrl });
  return job;
}

async function openMatch(match, email) {
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
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
    const currentUrl = changeInfo.url || tab?.url || "";
    if (job.status === "searching" && job.searchTabId === tabId && currentUrl.startsWith("https://www.google.com/search")) processSearchTab(tabId);
    else if (job.status === "running") {
      const record = (job.tabs || []).find((item) => item.tabId === tabId);
      if (record && currentUrl.startsWith("http")) scanLoadedTab(tabId);
    }
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await getJob();
  if (!job || !["running", "paused"].includes(job.status)) return;
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
        sendResponse({ settings: await getSettings(), job: await getJob() });
      } else if (message.type === "SET_SETTINGS") {
        const current = await getSettings();
        const next = { ...current, ...message.settings };
        next.excludedDomains = [...new Set((next.excludedDomains || []).map(normalizeDomain).filter(Boolean))];
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        sendResponse({ settings: next });
      } else if (message.type === "START_SEARCH") {
        sendResponse({ job: await startSearch(message.email, message.threshold) });
      } else if (message.type === "STOP_SEARCH") {
        sendResponse({ job: await stopJob() });
      } else if (message.type === "OPEN_MATCH") {
        const job = await getJob();
        await openMatch(message.match, job?.email || message.email);
        sendResponse({ ok: true });
      }
    } catch (error) {
      sendResponse({ error: error.message || "Something went wrong." });
    }
  })();
  return true;
});



