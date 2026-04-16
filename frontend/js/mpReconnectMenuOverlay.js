/**
 * Main-menu prompt: reconnect to soft-disconnected match or wait out the window.
 */
import { phaseTimerRowHtml, updatePhaseTimerBar } from "./mpMatchRoster.js";
import { playSfxMajor, playSfxMinor } from "./sfx.js";

const OVERLAY_ID = "mp-reconnect-menu-overlay";

/**
 * @param {import("./mpReconnectPending.js").MpReconnectPending} pending
 * @param {{
 *   onReconnect: () => void,
 *   onCancel: () => void,
 *   onExpired: () => void,
 * }} handlers
 */
export function showMpReconnectMenuOverlay(pending, handlers) {
  if (document.getElementById(OVERLAY_ID)) return;

  const untilMs = Math.ceil(Number(pending.reconnect_until_ts) * 1000);
  const totalSec = 120;

  const el = document.createElement("div");
  el.id = OVERLAY_ID;
  el.className = "mp-reconnect-menu-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "mp-reconnect-menu-title");

  const card = document.createElement("div");
  card.className = "mp-reconnect-menu-card";

  const title = document.createElement("p");
  title.id = "mp-reconnect-menu-title";
  title.className = "mp-reconnect-menu-title";
  title.textContent = "Would you like to reconnect to your previous match?";

  const timerHost = document.createElement("div");
  timerHost.className = "mp-reconnect-menu-timer";
  timerHost.innerHTML = phaseTimerRowHtml("mp-reconnect-menu");

  const actions = document.createElement("div");
  actions.className = "mp-reconnect-menu-actions";

  const btnReconnect = document.createElement("button");
  btnReconnect.type = "button";
  btnReconnect.className = "arcade-btn arcade-btn-primary";
  btnReconnect.textContent = "Reconnect";

  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.className = "arcade-btn arcade-btn-secondary";
  btnCancel.textContent = "Cancel";

  let closed = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let intervalId = null;

  const remove = () => {
    if (closed) return;
    closed = true;
    if (intervalId != null) window.clearInterval(intervalId);
    el.classList.remove("mp-reconnect-menu-overlay--visible");
    window.setTimeout(() => el.remove(), 220);
  };

  const tick = () => {
    if (closed) return;
    const remainSec = Math.max(0, (untilMs - Date.now()) / 1000);
    updatePhaseTimerBar(timerHost, "mp-reconnect-menu", totalSec, remainSec);
    if (remainSec <= 0) {
      remove();
      handlers.onExpired();
    }
  };

  btnReconnect.addEventListener("click", () => {
    playSfxMajor();
    remove();
    handlers.onReconnect();
  });

  btnCancel.addEventListener("click", () => {
    playSfxMinor();
    remove();
    handlers.onCancel();
  });

  actions.append(btnReconnect, btnCancel);
  card.append(title, timerHost, actions);
  el.appendChild(card);
  document.body.appendChild(el);

  tick();
  intervalId = window.setInterval(tick, 250);
  requestAnimationFrame(() => el.classList.add("mp-reconnect-menu-overlay--visible"));
}
