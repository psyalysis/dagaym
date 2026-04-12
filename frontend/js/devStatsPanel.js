/**
 * Dev-only stats (owner accounts): side tab toggles slide-out card. Server enforces access.
 */
import { getApiBase } from "./apiOrigin.js";
import { authBearerOnly, getUsername, isLoggedIn } from "./authApi.js";

const ALLOWED = new Set(["psyalysis", "polystalgia"]);
const POLL_MS = 8000;
const LS_EXPANDED = "dev_stats_panel_expanded";

let pollId = null;

function isDevUsername() {
  const u = getUsername().trim().toLowerCase();
  return Boolean(u && ALLOWED.has(u));
}

function syncCardAria(el) {
  const collapsed = el.classList.contains("dev-stats-panel--collapsed");
  const tab = el.querySelector(".dev-stats-panel__tab");
  const card = el.querySelector("#dev-stats-card");
  if (tab) tab.setAttribute("aria-expanded", collapsed ? "false" : "true");
  if (card) card.setAttribute("aria-hidden", collapsed ? "true" : "false");
}

function applyExpandedFromStorage(el) {
  let expanded = false;
  try {
    expanded = localStorage.getItem(LS_EXPANDED) === "1";
  } catch {
    /* ignore */
  }
  el.classList.toggle("dev-stats-panel--collapsed", !expanded);
  syncCardAria(el);
}

function wireTabToggle(el) {
  if (el.dataset.devToggleWired) return;
  el.dataset.devToggleWired = "1";
  const tab = el.querySelector(".dev-stats-panel__tab");
  if (!tab) return;
  tab.addEventListener("click", () => {
    el.classList.toggle("dev-stats-panel--collapsed");
    syncCardAria(el);
    const collapsed = el.classList.contains("dev-stats-panel--collapsed");
    try {
      localStorage.setItem(LS_EXPANDED, collapsed ? "0" : "1");
    } catch {
      /* ignore */
    }
  });
}

function ensureEl() {
  let el = document.getElementById("dev-stats-panel");
  if (!el) {
    el = document.createElement("div");
    el.id = "dev-stats-panel";
    el.className = "dev-stats-panel dev-stats-panel--collapsed";
    el.setAttribute("aria-label", "Developer stats");
    el.hidden = true;
    el.innerHTML = `
      <div class="dev-stats-panel__card" id="dev-stats-card">
        <div class="dev-stats-panel__label">Dev</div>
        <div class="dev-stats-panel__row">Players online: <span id="dev-stat-players">—</span></div>
        <div class="dev-stats-panel__row">Servers open: <span id="dev-stat-servers">—</span></div>
        <div class="dev-stats-panel__row">Total visits: <span id="dev-stat-visits">—</span></div>
      </div>
      <button type="button" class="dev-stats-panel__tab" aria-expanded="false" aria-controls="dev-stats-card">Dev</button>
    `;
    document.body.appendChild(el);
    applyExpandedFromStorage(el);
    wireTabToggle(el);
  }
  return el;
}

function teardown() {
  if (pollId !== null) {
    clearInterval(pollId);
    pollId = null;
  }
  const el = document.getElementById("dev-stats-panel");
  if (el) {
    el.hidden = true;
  }
}

async function fetchOnce() {
  if (!isLoggedIn() || !isDevUsername()) {
    teardown();
    return;
  }
  const base = getApiBase();
  const res = await fetch(`${base}/api/dev/site-stats`, { headers: authBearerOnly() });
  if (res.status === 401 || res.status === 403) {
    teardown();
    return;
  }
  if (!res.ok) return;
  const data = await res.json();
  const el = ensureEl();
  el.hidden = false;
  const p = el.querySelector("#dev-stat-players");
  const s = el.querySelector("#dev-stat-servers");
  const v = el.querySelector("#dev-stat-visits");
  if (p) p.textContent = String(data.players_online ?? "—");
  if (s) s.textContent = String(data.servers_open ?? "—");
  if (v) v.textContent = String(data.total_visits ?? "—");
}

/** Call on boot and after login. Idempotent polling. */
export function initDevStatsPanel() {
  if (!isLoggedIn() || !isDevUsername()) {
    teardown();
    return;
  }
  void fetchOnce();
  if (pollId !== null) return;
  pollId = window.setInterval(() => {
    void fetchOnce();
  }, POLL_MS);
}

export function recordPageVisit() {
  const base = getApiBase();
  void fetch(`${base}/api/stats/visit`, { method: "POST" }).catch(() => {});
}
