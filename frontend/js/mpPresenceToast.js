/**
 * Multiplayer player join/leave — top-center toasts, slide from top.
 */
import { playSfxPlayerJoin, playSfxPlayerLeave, playSfxSoloMatchAlarm } from "./sfx.js";

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
      : "mp-presence-toast mp-presence-toast--leave";
  card.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "mp-presence-toast-text";
  text.textContent = label;
  card.appendChild(text);
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
  show("join", `${name} joined`);
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
  show("leave", `${name} left`);
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
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  return import("./screens/modeSelect.js").then((mod) => ctx.navigate(mod.mountModeSelectScreen));
}
