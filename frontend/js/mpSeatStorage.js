/** Persist MP seat for WebSocket resume (session tab). */
const K_LOBBY = "cookup_mp_lobby_id";
const K_PLAYER = "cookup_mp_player_id";

/** @param {string} lobbyId @param {string} playerId */
export function saveMpSeat(lobbyId, playerId) {
  const l = String(lobbyId || "").trim();
  const p = String(playerId || "").trim();
  if (!l || !p) return;
  try {
    sessionStorage.setItem(K_LOBBY, l);
    sessionStorage.setItem(K_PLAYER, p);
  } catch {
    /* ignore */
  }
}

export function clearMpSeat() {
  try {
    sessionStorage.removeItem(K_LOBBY);
    sessionStorage.removeItem(K_PLAYER);
  } catch {
    /* ignore */
  }
}

/** @returns {string} */
export function getStoredMpLobbyId() {
  try {
    return sessionStorage.getItem(K_LOBBY)?.trim() || "";
  } catch {
    return "";
  }
}

/** @returns {string} */
export function getStoredMpPlayerId() {
  try {
    return sessionStorage.getItem(K_PLAYER)?.trim() || "";
  } catch {
    return "";
  }
}
