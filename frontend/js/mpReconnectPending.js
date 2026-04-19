/**
 * GET /api/me/mp_reconnect_pending + optional sessionStorage suppress (legacy / edge).
 */
import { authBearerOnly } from "./authApi.js";
import { getApiBase } from "./apiOrigin.js";

const SS_UNTIL = "beatbattle_mp_reconnect_suppress_until_ms";
const SS_PID = "beatbattle_mp_reconnect_suppress_player_id";

/**
 * @typedef {{ lobby_id: string; player_id: string; reconnect_until_ts: number; seconds_remaining: number; grace_total_s: number }} MpReconnectPending
 */

/**
 * Clears soft-disconnect grace server-side (same as finishing leave_lobby). Call after Leave.
 * @returns {Promise<boolean>}
 */
export async function abandonReconnectGrace() {
  const base = getApiBase();
  try {
    const res = await fetch(`${base}/api/me/mp_abandon_reconnect`, {
      method: "POST",
      headers: authBearerOnly(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<MpReconnectPending | null>}
 */
export async function fetchMpReconnectPending() {
  const base = getApiBase();
  try {
    const res = await fetch(`${base}/api/me/mp_reconnect_pending`, {
      headers: authBearerOnly(),
    });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    const data = await res.json();
    if (data == null || typeof data !== "object") return null;
    const lobby_id = String(data.lobby_id ?? "").trim();
    const player_id = String(data.player_id ?? "").trim();
    if (!lobby_id || !player_id) return null;
    const grace_total_s = Number(data.grace_total_s);
    return {
      lobby_id,
      player_id,
      reconnect_until_ts: Number(data.reconnect_until_ts),
      seconds_remaining: Number(data.seconds_remaining) || 0,
      grace_total_s:
        Number.isFinite(grace_total_s) && grace_total_s > 0
          ? grace_total_s
          : 60,
    };
  } catch {
    return null;
  }
}

/** Exported for hub poll / expiry refresh. @returns {{ untilMs: number; playerId: string } | null} */
export function getReconnectSuppressState() {
  try {
    const until = Number(sessionStorage.getItem(SS_UNTIL));
    const pid = sessionStorage.getItem(SS_PID)?.trim() || "";
    if (!Number.isFinite(until) || !pid) return null;
    if (Date.now() >= until) {
      sessionStorage.removeItem(SS_UNTIL);
      sessionStorage.removeItem(SS_PID);
      return null;
    }
    return { untilMs: until, playerId: pid };
  } catch {
    return null;
  }
}

export function clearReconnectSuppress() {
  try {
    sessionStorage.removeItem(SS_UNTIL);
    sessionStorage.removeItem(SS_PID);
  } catch {
    /* ignore */
  }
}

/**
 * @param {MpReconnectPending | null} pending
 */
export function cleanupReconnectSuppressIfNoPending(pending) {
  if (!pending) clearReconnectSuppress();
}

/**
 * @param {MpReconnectPending | null} pending
 */
export function shouldShowReconnectOverlay(pending) {
  if (!pending) return false;
  const st = getReconnectSuppressState();
  if (!st) return true;
  return st.playerId !== pending.player_id;
}

/**
 * @param {MpReconnectPending | null} pending
 */
export function isHubBlockedByReconnectDismiss(pending) {
  if (!pending) return false;
  const st = getReconnectSuppressState();
  if (!st) return false;
  return st.playerId === pending.player_id;
}
