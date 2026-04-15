/**
 * Slide-out numbers for us — the API still checks you're on the list.
 */
import { getApiBase } from "./apiOrigin.js";
import { authBearerOnly, getUsername, isLoggedIn } from "./authApi.js";
import { refreshSupportersFromApi } from "./supporters.js";

const ALLOWED = new Set(["psyalysis", "polystalgia"]);
const POLL_MS = 8000;
const LS_EXPANDED = "dev_stats_panel_expanded";

let pollId = null;
let slashListenerWired = false;

function isTypingTarget(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function wireSlashToggle() {
  if (slashListenerWired) return;
  slashListenerWired = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "/" && e.code !== "Slash") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!isLoggedIn() || !isDevUsername()) return;
      if (isTypingTarget(/** @type {HTMLElement} */ (e.target))) return;
      e.preventDefault();
      const el = ensureEl();
      el.hidden = false;
      el.classList.toggle("dev-stats-panel--concealed");
    },
    true,
  );
}

function isDevUsername() {
  const u = getUsername().trim();
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
  if (el && !el.querySelector("#dev-supporter-list")) {
    el.remove();
    el = null;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "dev-stats-panel";
    el.className = "dev-stats-panel dev-stats-panel--collapsed dev-stats-panel--concealed";
    el.setAttribute("aria-label", "Developer stats");
    el.innerHTML = `
      <div class="dev-stats-panel__card" id="dev-stats-card">
        <div class="dev-stats-panel__label">Dev</div>
        <div class="dev-stats-panel__row">Players online: <span id="dev-stat-players">—</span></div>
        <div class="dev-stats-panel__row">Servers open: <span id="dev-stat-servers">—</span></div>
        <div class="dev-stats-panel__row">Total visits: <span id="dev-stat-visits">—</span></div>
        <div class="dev-stats-panel__label">Supporters</div>
        <div class="dev-stats-panel__row dev-stats-panel__row--block">Names: <span id="dev-supporter-list">—</span></div>
        <div class="dev-stats-panel__row dev-stats-panel__row--supporter-form">
          <input type="text" id="dev-supporter-input" class="dev-stats-panel__input" maxlength="64" placeholder="name" autocomplete="off" aria-label="Supporter display name" />
          <button type="button" class="arcade-btn dev-stats-panel__mini-btn" id="dev-supporter-add">Add</button>
          <button type="button" class="arcade-btn dev-stats-panel__mini-btn" id="dev-supporter-remove">Remove</button>
        </div>
        <p class="dev-stats-panel__hint" id="dev-supporter-msg" aria-live="polite"></p>
      </div>
      <button type="button" class="dev-stats-panel__tab" aria-expanded="false" aria-controls="dev-stats-card">Dev</button>
    `;
    document.body.appendChild(el);
    applyExpandedFromStorage(el);
    wireTabToggle(el);
    wireSupportersDevUi(el);
  }
  return el;
}

async function updateDevSupporterListRow(panelEl) {
  const listEl = panelEl.querySelector("#dev-supporter-list");
  if (!listEl) return;
  const base = getApiBase();
  const res = await fetch(`${base}/api/supporters`);
  if (!res.ok) {
    listEl.textContent = "—";
    return;
  }
  const data = await res.json();
  const names = Array.isArray(data.names) ? data.names : [];
  listEl.textContent = names.length ? names.join(", ") : "—";
}

function wireSupportersDevUi(el) {
  if (el.dataset.devSupportersWired) return;
  el.dataset.devSupportersWired = "1";
  const base = getApiBase();
  const input = el.querySelector("#dev-supporter-input");
  const addBtn = el.querySelector("#dev-supporter-add");
  const rmBtn = el.querySelector("#dev-supporter-remove");
  const msg = el.querySelector("#dev-supporter-msg");

  const setMsg = (t) => {
    if (msg) msg.textContent = t || "";
  };

  addBtn?.addEventListener("click", async () => {
    const raw = input instanceof HTMLInputElement ? input.value : "";
    const name = raw.trim();
    if (!name) {
      setMsg("Enter a name.");
      return;
    }
    setMsg("");
    const res = await fetch(`${base}/api/dev/supporters`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authBearerOnly() },
      body: JSON.stringify({ name }),
    });
    if (res.status === 401 || res.status === 403) {
      setMsg("Not allowed.");
      return;
    }
    if (res.status === 409) {
      setMsg("Already listed.");
      return;
    }
    if (!res.ok) {
      setMsg("Could not add.");
      return;
    }
    if (input instanceof HTMLInputElement) input.value = "";
    await refreshSupportersFromApi();
    await updateDevSupporterListRow(el);
    setMsg("Added.");
    window.setTimeout(() => setMsg(""), 2000);
  });

  rmBtn?.addEventListener("click", async () => {
    const raw = input instanceof HTMLInputElement ? input.value : "";
    const name = raw.trim();
    if (!name) {
      setMsg("Enter a name to remove.");
      return;
    }
    setMsg("");
    const q = new URLSearchParams({ name });
    const res = await fetch(`${base}/api/dev/supporters?${q}`, {
      method: "DELETE",
      headers: authBearerOnly(),
    });
    if (res.status === 401 || res.status === 403) {
      setMsg("Not allowed.");
      return;
    }
    if (res.status === 404) {
      setMsg("Not in list.");
      return;
    }
    if (!res.ok) {
      setMsg("Could not remove.");
      return;
    }
    if (input instanceof HTMLInputElement) input.value = "";
    await refreshSupportersFromApi();
    await updateDevSupporterListRow(el);
    setMsg("Removed.");
    window.setTimeout(() => setMsg(""), 2000);
  });
}

function teardown() {
  if (pollId !== null) {
    clearInterval(pollId);
    pollId = null;
  }
  const el = document.getElementById("dev-stats-panel");
  if (el) {
    el.hidden = true;
    el.classList.add("dev-stats-panel--concealed");
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
  void updateDevSupporterListRow(el);
}

/** Safe to spam; only one poll loop and only if your user is allowed. */
export function initDevStatsPanel() {
  if (!isLoggedIn() || !isDevUsername()) {
    teardown();
    return;
  }
  wireSlashToggle();
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
