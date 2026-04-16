/** MP lobby-shaped payloads, phase timer markup, and the dotted progress hints + tooltips. */
import { escapeHtml } from "./rankUi.js";

/**
 * @typedef {{
 *   id?: string;
 *   name?: string;
 *   ready?: boolean;
 *   rank?: unknown;
 *   connected?: boolean;
 *   grace_deadline_ts?: number | null;
 * }} LobbyPlayerRow
 * @typedef {{
 *   host_id?: string;
 *   players?: LobbyPlayerRow[];
 *   cook_finished?: string[];
 *   uploaded?: string[];
 *   votes?: Record<string, string>;
 *   player_count?: number;
 *   slideshow_completed?: string[];
 * }} LobbyLike
 */

/** @param {unknown} v */
function asStrArr(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x));
}

/** @param {unknown} v */
function asVoteMap(v) {
  if (!v || typeof v !== "object") return {};
  /** @type {Record<string, string>} */
  const o = {};
  for (const [k, val] of Object.entries(v)) {
    o[String(k)] = String(val);
  }
  return o;
}

/**
 * @param {LobbyLike | null | undefined} raw
 * @returns {Required<Pick<LobbyLike, "host_id">> & { players: LobbyPlayerRow[]; cook_finished: string[]; uploaded: string[]; votes: Record<string, string>; player_count: number; slideshow_completed: string[] }}
 */
export function normalizeLobbyLike(raw) {
  const players = Array.isArray(raw?.players) ? raw.players.map((p) => ({ ...p, id: String(p?.id ?? "") })) : [];
  const n = Number(raw?.player_count);
  const player_count = Number.isFinite(n) && n > 0 ? n : players.length;
  return {
    host_id: String(raw?.host_id ?? ""),
    players,
    cook_finished: asStrArr(raw?.cook_finished),
    uploaded: asStrArr(raw?.uploaded),
    votes: asVoteMap(raw?.votes),
    slideshow_completed: asStrArr(raw?.slideshow_completed),
    player_count,
  };
}

/**
 * @param {LobbyLike | null | undefined} prev
 * @param {Record<string, unknown>} msg
 * @returns {ReturnType<typeof normalizeLobbyLike>}
 */
export function applyMatchWsToLobby(prev, msg) {
  const base = normalizeLobbyLike(prev);
  const t = msg?.type;
  if (t === "lobby_update" && msg.lobby && typeof msg.lobby === "object") {
    return normalizeLobbyLike(/** @type {LobbyLike} */ (msg.lobby));
  }
  if (t === "cook_finished_update" && Array.isArray(msg.finished_player_ids)) {
    base.cook_finished = msg.finished_player_ids.map((x) => String(x));
    const pc = Number(msg.player_count);
    if (Number.isFinite(pc) && pc > 0) base.player_count = pc;
    return base;
  }
  if (t === "beat_uploaded" && msg.player_id != null) {
    const id = String(msg.player_id);
    const s = new Set(base.uploaded);
    s.add(id);
    base.uploaded = [...s].sort();
    return base;
  }
  if (t === "vote_cast" && msg.voter_id != null && msg.target_player_id != null) {
    base.votes = { ...base.votes, [String(msg.voter_id)]: String(msg.target_player_id) };
    return base;
  }
  return base;
}

/**
 * @param {Record<string, unknown> | null} sync
 * @returns {LobbyLike | null}
 */
export function lobbyLikeFromMatchSync(sync) {
  if (!sync || typeof sync !== "object") return null;
  return {
    host_id: sync.host_id != null ? String(sync.host_id) : "",
    players: Array.isArray(sync.players) ? /** @type {LobbyPlayerRow[]} */ (sync.players) : [],
    cook_finished: asStrArr(sync.cook_finished),
    uploaded: asStrArr(sync.uploaded),
    votes: asVoteMap(sync.votes),
    player_count: Number(sync.player_count) || 0,
    slideshow_completed: asStrArr(sync.slideshow_completed),
  };
}

/**
 * Horizontal countdown bar: fill width = fraction of time remaining (drains toward deadline).
 * @param {HTMLElement} root
 * @param {string} idPrefix e.g. "mp-cook-phase" → fill id mp-cook-phase-fill
 * @param {number} totalSec window length (>0)
 * @param {number} remainSec >=0
 */
export function updatePhaseTimerBar(root, idPrefix, totalSec, remainSec) {
  const fill = root.querySelector(`#${idPrefix}-fill`);
  const label = root.querySelector(`#${idPrefix}-label`);
  const total = Math.max(0.001, totalSec);
  const r = Math.max(0, remainSec);
  const pct = Math.min(100, Math.max(0, (r / total) * 100));
  if (fill instanceof HTMLElement) fill.style.width = `${pct}%`;
  const s = Math.max(0, Math.ceil(r));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const text = `${m}:${String(sec).padStart(2, "0")}`;
  if (label) label.textContent = text;
}

/**
 * Markup for phase timer: time centered above the bar. Caller runs updatePhaseTimerBar on an interval.
 * @param {string} idPrefix
 */
export function phaseTimerRowHtml(idPrefix) {
  return `<div class="mp-phase-timer" aria-live="polite">
  <span class="mp-phase-timer-label" id="${idPrefix}-label">0:00</span>
  <div class="mp-phase-timer-bar-wrap" role="presentation">
    <div class="mp-phase-timer-bar-fill" id="${idPrefix}-fill" style="width:100%"></div>
  </div>
</div>`;
}

/** Progress hint trigger (dotted label + hover tooltip). Place inside `.mp-panel-head-roster`. */
export function progressHintSlotHtml(id) {
  return `<span id="${id}" class="mp-progress-hint-wrap hidden" aria-live="polite"></span>`;
}

/**
 * Same rule as server _required_voters: must vote if someone else uploaded a beat.
 * @param {ReturnType<typeof normalizeLobbyLike>} v
 * @returns {string[]}
 */
export function requiredVoterIds(v) {
  const uploaded = new Set(v.uploaded || []);
  if (uploaded.size === 0) return [];
  const out = [];
  for (const p of v.players) {
    const id = String(p.id ?? "");
    if (!id) continue;
    if ([...uploaded].some((b) => b !== id)) out.push(id);
  }
  return out;
}

/**
 * @param {LobbyPlayerRow[]} players
 * @param {Set<string>} doneIds
 */
function sortedNamesByDone(players, doneIds) {
  const rows = players.map((p) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? p.id ?? ""),
    done: doneIds.has(String(p.id ?? "")),
  }));
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return rows;
}

/**
 * @param {LobbyPlayerRow[]} players
 * @param {Set<string>} doneIds
 */
function nameRowsTooltipHtml(players, doneIds) {
  const rows = sortedNamesByDone(players, doneIds);
  return rows
    .map((r) => {
      const raw = players.find((p) => String(p.id ?? "") === r.id);
      const base = `mp-tip-name mp-tip-name--${r.done ? "done" : "todo"}`;
      let dc = "";
      if (raw && raw.connected === false) {
        const gd = raw.grace_deadline_ts;
        if (gd != null && Number.isFinite(Number(gd))) {
          dc = " mp-tip-name--dc-grace";
        } else {
          dc = " mp-tip-name--dc-lost";
        }
      }
      return `<span class="${base}${dc}">${escapeHtml(r.name)}</span>`;
    })
    .join("<br>");
}

/**
 * @param {HTMLElement | null} wrap
 * @param {string} labelText e.g. "2 / 4 finished"
 * @param {string} tooltipHtml built from escaped player names in this module
 */
function setProgressHintTooltip(wrap, labelText, tooltipHtml) {
  if (!wrap) return;
  wrap.innerHTML = `<span class="mp-progress-hint-text">${escapeHtml(labelText)}</span><div class="mp-tooltip" role="tooltip">${tooltipHtml}</div>`;
}

/**
 * @param {HTMLElement | null} el
 * @param {ReturnType<typeof normalizeLobbyLike>} v
 */
function setCookProgressHint(el, v) {
  if (!el) return;
  if (!v.players.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const ids = v.cook_finished;
  const n = ids.length;
  const tot = Math.max(1, v.player_count || v.players.length);
  const done = new Set(ids.map((x) => String(x)));
  setProgressHintTooltip(el, `${n} / ${tot} finished`, nameRowsTooltipHtml(v.players, done));
}

/**
 * @param {HTMLElement | null} el
 * @param {ReturnType<typeof normalizeLobbyLike>} v
 */
function setUploadProgressHint(el, v) {
  if (!el) return;
  if (!v.players.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const tot = Math.max(1, v.player_count || v.players.length);
  const up = v.uploaded.filter((id) => v.players.some((p) => p.id === id)).length;
  const done = new Set(v.uploaded.map((x) => String(x)));
  setProgressHintTooltip(el, `${up} / ${tot} uploaded`, nameRowsTooltipHtml(v.players, done));
}

/**
 * @param {HTMLElement | null} el
 * @param {ReturnType<typeof normalizeLobbyLike>} v
 */
function setVoteProgressHint(el, v) {
  if (!el) return;
  const reqIds = requiredVoterIds(v);
  const req = new Set(reqIds);
  if (req.size === 0) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const voted = new Set(Object.keys(v.votes || {}));
  const n = reqIds.filter((id) => voted.has(id)).length;
  const total = Math.max(1, reqIds.length);
  const voters = v.players.filter((p) => req.has(String(p.id ?? "")));
  const tip = nameRowsTooltipHtml(voters, voted);
  setProgressHintTooltip(el, `${n} / ${total} voted`, tip || '<span class="mp-tip-name mp-tip-name--todo">—</span>');
}

/**
 * Results rematch: same dotted label + hover name rows as cook/upload/vote.
 * @param {HTMLElement | null} el
 * @param {Array<{ id: string; name: string }>} players current lobby members (for denominator + tooltip)
 * @param {Set<string> | Iterable<string>} votedIds player ids who voted rematch
 */
export function setRematchProgressHint(el, players, votedIds) {
  if (!el) return;
  const voted = votedIds instanceof Set ? votedIds : new Set(Array.from(votedIds || [], String));
  if (!players.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const rows = players.map((p) => ({ id: String(p.id ?? ""), name: String(p.name ?? p.id ?? "") }));
  const n = rows.filter((p) => p.id && voted.has(p.id)).length;
  const tot = rows.length;
  setProgressHintTooltip(el, `${n} / ${tot} Rematch`, nameRowsTooltipHtml(rows, voted));
}

/**
 * Re-render the progress hint for one MP phase (cook / upload / vote) after lobbyView changes.
 * @param {HTMLElement} root screen mount root
 * @param {string} hintElementId DOM id without #
 * @param {'cook' | 'upload' | 'vote'} phase
 * @param {ReturnType<typeof normalizeLobbyLike>} lobbyView
 */
export function syncMatchProgressHint(root, hintElementId, phase, lobbyView) {
  const el = root.querySelector(`#${hintElementId}`);
  if (phase === "cook") setCookProgressHint(el, lobbyView);
  else if (phase === "upload") setUploadProgressHint(el, lobbyView);
  else setVoteProgressHint(el, lobbyView);
}
