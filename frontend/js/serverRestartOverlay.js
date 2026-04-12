/**
 * Shown when the multiplayer WebSocket drops unexpectedly (e.g. server redeploy).
 */

const OVERLAY_ID = "server-restart-overlay";

export function showServerRestartingWait() {
  if (document.getElementById(OVERLAY_ID)) return;

  const el = document.createElement("div");
  el.id = OVERLAY_ID;
  el.className = "server-restart-overlay";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const card = document.createElement("div");
  card.className = "server-restart-card";

  const title = document.createElement("p");
  title.className = "server-restart-title";
  title.textContent = "Server is restarting… please wait!";

  const hint = document.createElement("p");
  hint.className = "server-restart-hint";
  hint.textContent =
    "The connection was lost. If this message stays, return to the menu or refresh the page.";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "arcade-btn arcade-btn-primary server-restart-dismiss";
  btn.textContent = "OK";

  btn.addEventListener("click", () => {
    el.classList.remove("server-restart-overlay--visible");
    window.setTimeout(() => el.remove(), 220);
  });

  card.append(title, hint, btn);
  el.appendChild(card);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("server-restart-overlay--visible"));
}

export function dismissServerRestartingWait() {
  const el = document.getElementById(OVERLAY_ID);
  if (!el) return;
  el.classList.remove("server-restart-overlay--visible");
  window.setTimeout(() => el.remove(), 220);
}
