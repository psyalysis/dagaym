/**
 * Preflight for joining a public lobby by id (server list). Uses the same rules as GET /api/lobbies.
 */
import { getApiBase } from "./apiOrigin.js";

/**
 * @param {string} lobbyId
 * @returns {Promise<boolean>} true if the lobby is still on the public joinable list
 */
export async function fetchPublicLobbyJoinable(lobbyId) {
  const raw = String(lobbyId ?? "").trim();
  if (raw.length < 3) return false;
  try {
    const base = getApiBase();
    const res = await fetch(
      `${base}/api/lobbies/joinable/${encodeURIComponent(raw)}`,
      { method: "GET", cache: "no-store" },
    );
    return res.ok;
  } catch {
    return false;
  }
}
