/**
 * Global error toasts — server refs, client failures, and top-level script errors.
 */

const HOST_ID = "app-error-toast-host";
const AUTO_DISMISS_MS = 14000;

function ensureHost() {
  let h = document.getElementById(HOST_ID);
  if (!h) {
    h = document.createElement("div");
    h.id = HOST_ID;
    h.className = "app-error-toast-host";
    h.setAttribute("aria-live", "assertive");
    document.body.appendChild(h);
  }
  return h;
}

/**
 * @param {{
 *   message: string,
 *   errorRef?: string | null,
 *   errorCode?: string | null,
 *   source?: string,
 * }} detail
 */
export function showAppError(detail) {
  const message = detail.message || "Something went wrong.";
  const ref = detail.errorRef ?? null;
  const code = detail.errorCode ?? null;

  const host = ensureHost();
  const card = document.createElement("div");
  card.className = "app-error-toast";
  card.setAttribute("role", "alert");

  const msgEl = document.createElement("p");
  msgEl.className = "app-error-toast-msg";
  msgEl.textContent = message;

  const meta = document.createElement("p");
  meta.className = "app-error-toast-meta";
  const parts = [];
  if (ref) parts.push(`Ref ${ref}`);
  if (code) parts.push(`Code ${code}`);
  if (parts.length) {
    meta.textContent = `${parts.join(" · ")} — send this with bug reports.`;
  } else {
    meta.textContent = "Note what you clicked and when if you report this.";
  }

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "app-error-toast-dismiss arcade-btn arcade-btn-secondary";
  dismiss.textContent = "Dismiss";

  let hideTimer = 0;

  const removeCard = () => {
    card.classList.remove("app-error-toast--visible");
    window.setTimeout(() => card.remove(), 220);
  };

  dismiss.addEventListener("click", () => {
    if (hideTimer) window.clearTimeout(hideTimer);
    removeCard();
  });

  card.append(msgEl, meta, dismiss);
  host.appendChild(card);
  requestAnimationFrame(() => card.classList.add("app-error-toast--visible"));

  hideTimer = window.setTimeout(removeCard, AUTO_DISMISS_MS);
}

/** Multiplayer WebSocket `type: "error"` payload (snake_case from server). */
export function notifyMpServerError(m) {
  if (!m || m.type !== "error") return;
  showAppError({
    message: m.message || "Server error.",
    errorRef: m.error_ref ?? null,
    errorCode: m.error_code ?? null,
    source: "server",
  });
}
