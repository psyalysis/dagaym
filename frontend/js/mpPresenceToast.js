/**
 * Someone joined or left — little toast drops from the top.
 */
import { clearMpChatSession } from "./mpChat.js";
import { clearMpSeat } from "./mpSeatStorage.js";
import { playSfxPlayerJoin, playSfxPlayerLeave, playSfxSoloMatchAlarm } from "./sfx.js";
import { supporterPlainPrefix } from "./supporters.js";

const HOST_ID = "mp-presence-toast-host";
const VISIBLE_MS = 3200;
const FADE_MS = 220;

function ensureHost() {
  let h = document.getElementById(HOST_ID);
  if (!h) {
    h = document.createElement("div");
    h.id = HOST_ID;
    h.className = "mp-presence-toast-host";
    h.setAttribute("aria-live", "polite");
    document.body.appendChild(h);
  }
  return h;
}

function show(kind, label) {
  const host = ensureHost();
  const card = document.createElement("div");
  card.className =
    kind === "join"
      ? "mp-presence-toast mp-presence-toast--join"
      : kind === "leave"
        ? "mp-presence-toast mp-presence-toast--leave"
        : kind === "kick"
          ? "mp-presence-toast mp-presence-toast--kick"
          : kind === "disconnect"
            ? "mp-presence-toast mp-presence-toast--disconnect"
            : "mp-presence-toast mp-presence-toast--rematch";
  card.setAttribute("role", "status");
  if (kind === "disconnect") {
    const emoji = document.createElement("div");
    emoji.className = "mp-presence-toast-socket";
    emoji.setAttribute("aria-hidden", "true");
    emoji.textContent = "\u{1F50C}";
    const text = document.createElement("span");
    text.className = "mp-presence-toast-text";
    text.textContent = label;
    card.append(emoji, text);
  } else {
    const text = document.createElement("span");
    text.className = "mp-presence-toast-text";
    text.textContent = label;
    card.appendChild(text);
  }
  host.appendChild(card);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => card.classList.add("mp-presence-toast--visible"));
  });
  window.setTimeout(() => {
    card.classList.remove("mp-presence-toast--visible");
    window.setTimeout(() => card.remove(), FADE_MS);
  }, VISIBLE_MS);
}

/**
 * @param {unknown} m — WS message
 * @param {string} selfId
 */
export function notifyMpPlayerJoin(m, selfId) {
  if (!m || m.type !== "player_join" || !m.player) return;
  const id = String(m.player.id ?? "");
  const name = String(m.player.name ?? "").trim() || "Player";
  if (!id || id === selfId) return;
  playSfxPlayerJoin();
  show("join", `${supporterPlainPrefix(name)}${name} joined`);
}

/**
 * @param {unknown} m — WS message
 * @param {string} selfId
 */
export function notifyMpPlayerLeave(m, selfId) {
  if (!m || m.type !== "player_leave") return;
  const id = String(m.player_id ?? "");
  if (!id || id === selfId) return;
  const name = String(m.name ?? "").trim() || "Player";
  playSfxPlayerLeave();
  show("leave", `${supporterPlainPrefix(name)}${name} left the game`);
}

/**
 * Soft WebSocket drop — player may still rejoin during grace.
 * @param {unknown} m
 * @param {string} selfId
 */
export function notifyMpPlayerDisconnected(m, selfId) {
  if (!m || m.type !== "player_disconnected") return;
  const id = String(m.player_id ?? "");
  if (!id || id === selfId) return;
  const name = String(m.name ?? "").trim() || "Player";
  playSfxPlayerLeave();
  show("disconnect", `${supporterPlainPrefix(name)}${name} disconnected`);
}

/**
 * @param {unknown} m — WS message
 * @param {string} selfId
 */
/** You were removed by the host — short toast, then client closes WS. */
export function showKickedFromMatchToast() {
  show("kick", "You were kicked from the match");
}

export function notifyRematchWant(m, selfId) {
  if (!m || m.type !== "rematch_vote_update") return;
  const id = String(m.voter_id ?? "");
  const name = String(m.name ?? "").trim() || "Player";
  if (!id || id === selfId) return;
  show("rematch", `${supporterPlainPrefix(name)}${name} wants to rematch!`);
}

/**
 * @param {object} ctx — app navigate context
 * @param {WebSocket} ws
 * @param {{ reason?: string }} m — `lobby_dissolved` payload
 */
export function navigateToMenuAfterLobbyDissolved(ctx, ws, m) {
  if (m && m.reason === "only_player_left") {
    playSfxSoloMatchAlarm();
  }
  clearMpChatSession();
  clearMpSeat();
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  return import("./screens/modeSelect.js").then((mod) => ctx.navigate(mod.mountModeSelectScreen));
}
