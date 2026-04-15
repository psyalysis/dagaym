/** Thin banner while multiplayer WebSocket reconnects. */

const BANNER_ID = "mp-reconnect-banner";

export function showMpReconnectBanner(attempt, maxAttempts) {
  let el = document.getElementById(BANNER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = BANNER_ID;
    el.className = "mp-reconnect-banner";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent =
    maxAttempts > 0
      ? `Reconnecting… (${attempt}/${maxAttempts})`
      : `Reconnecting… (${attempt})`;
  requestAnimationFrame(() => el.classList.add("mp-reconnect-banner--visible"));
}

export function hideMpReconnectBanner() {
  const el = document.getElementById(BANNER_ID);
  if (!el) return;
  el.classList.remove("mp-reconnect-banner--visible");
  window.setTimeout(() => el.remove(), 200);
}
