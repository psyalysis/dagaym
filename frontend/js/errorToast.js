/**
 * Red toast when something breaks — ours, the server's, or a script in the wild.
 */

const HOST_ID = "app-error-toast-host";
const AUTO_DISMISS_MS = 14000;

/** @type {AppErrorContext} */
let appErrorContext = {};

/**
 * @typedef {{
 *   screen?: string,
 *   phase?: string,
 *   lobbyId?: string,
 *   playerId?: string,
 * }} AppErrorContext
 */

/** Clears context on each full navigation (see main.js). */
export function resetAppErrorContext() {
  appErrorContext = {};
}

/** Merge labels for where the user was (lobby phase, screen name, etc.). */
export function setAppErrorContext(
  /** @type {Partial<AppErrorContext>} */ partial,
) {
  appErrorContext = { ...appErrorContext, ...partial };
}

function browserLabel() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Chrome\//.test(ua) && !/Edg|OPR/.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return "Safari";
  return ua ? "Unknown" : "Unknown";
}

/**
 * @param {object} merged
 * @param {string} merged.message
 * @param {string | null} [merged.errorRef]
 * @param {string | null} [merged.errorCode]
 * @param {string} [merged.source]
 */
function buildCopyReport(merged) {
  const lines = [
    "Beat Battle error report",
    "────────────────────",
    `Time (UTC): ${new Date().toISOString()}`,
  ];
  try {
    const u = new URL(
      typeof location !== "undefined" ? location.href : "about:blank",
    );
    lines.push(`Page: ${u.origin}${u.pathname}`);
  } catch {
    lines.push("Page: (unavailable)");
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  lines.push(`Browser: ${browserLabel()}`);
  if (ua) lines.push(`User-Agent: ${ua}`);
  if (typeof window !== "undefined") {
    lines.push(`Viewport: ${window.innerWidth}×${window.innerHeight}`);
    if (typeof window.devicePixelRatio === "number") {
      lines.push(`Device pixel ratio: ${window.devicePixelRatio}`);
    }
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    lines.push(`Language: ${navigator.language}`);
  }
  if (merged.screen) lines.push(`Screen: ${merged.screen}`);
  if (merged.phase) lines.push(`Stage / phase: ${merged.phase}`);
  if (merged.lobbyId) lines.push(`Lobby id: ${merged.lobbyId}`);
  if (merged.playerId) lines.push(`Player id: ${merged.playerId}`);
  lines.push(`Source: ${merged.source || "client"}`);
  if (merged.errorRef) lines.push(`Server ref: ${merged.errorRef}`);
  if (merged.errorCode) lines.push(`Error code: ${merged.errorCode}`);
  lines.push("");
  lines.push(`Message: ${merged.message || "(none)"}`);
  if (merged.hint) lines.push(`Hint: ${merged.hint}`);
  if (merged.extraLines && merged.extraLines.length) {
    lines.push("");
    merged.extraLines.forEach((l) => lines.push(l));
  }
  return lines.join("\n");
}

async function copyText(text) {
  try {
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

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
 *   hint?: string | null,
 *   phase?: string | null,
 *   extraLines?: string[],
 * }} detail
 */
export function showAppError(detail) {
  const message = detail.message || "Something went wrong.";
  const ref = detail.errorRef ?? null;
  const code = detail.errorCode ?? null;
  const hint = detail.hint ?? null;
  const phaseOverride = detail.phase ?? null;
  const extraLines = detail.extraLines ?? [];

  const merged = {
    ...appErrorContext,
    message,
    errorRef: ref,
    errorCode: code,
    source: detail.source ?? "client",
    hint: hint || undefined,
    phase: phaseOverride || appErrorContext.phase,
    screen: appErrorContext.screen,
    lobbyId: appErrorContext.lobbyId,
    playerId: appErrorContext.playerId,
    extraLines,
  };

  const copyPayload = buildCopyReport(merged);

  const host = ensureHost();
  const card = document.createElement("div");
  card.className = "app-error-toast";
  card.setAttribute("role", "alert");

  const msgEl = document.createElement("p");
  msgEl.className = "app-error-toast-msg";
  msgEl.textContent = message;

  card.appendChild(msgEl);

  if (hint) {
    const hintEl = document.createElement("p");
    hintEl.className = "app-error-toast-hint";
    hintEl.textContent = hint;
    card.appendChild(hintEl);
  }

  const meta = document.createElement("p");
  meta.className = "app-error-toast-meta";
  const metaParts = [];
  if (ref) metaParts.push(`Ref ${ref}`);
  if (code) metaParts.push(`Code ${code}`);
  if (metaParts.length) {
    meta.textContent = `${metaParts.join(" · ")} — use Copy details if you report this.`;
  } else {
    meta.textContent =
      "Use Copy details to share what went wrong with the developer.";
  }
  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "app-error-toast-actions";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "app-error-toast-copy arcade-btn arcade-btn-secondary";
  copyBtn.textContent = "Copy details";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "app-error-toast-dismiss arcade-btn arcade-btn-secondary";
  dismiss.textContent = "Dismiss";

  let hideTimer = 0;

  const removeCard = () => {
    card.classList.remove("app-error-toast--visible");
    window.setTimeout(() => card.remove(), 220);
  };

  copyBtn.addEventListener("click", async () => {
    const ok = await copyText(copyPayload);
    copyBtn.textContent = ok ? "Copied" : "Copy failed";
    window.setTimeout(() => {
      copyBtn.textContent = "Copy details";
    }, 2000);
  });

  dismiss.addEventListener("click", () => {
    if (hideTimer) window.clearTimeout(hideTimer);
    removeCard();
  });

  actions.append(copyBtn, dismiss);
  card.appendChild(actions);
  host.appendChild(card);
  requestAnimationFrame(() => card.classList.add("app-error-toast--visible"));

  hideTimer = window.setTimeout(removeCard, AUTO_DISMISS_MS);
}

/** Server sent type:error over MP — snake_case keys, we normalize for the toast. */
export function notifyMpServerError(m) {
  if (!m || m.type !== "error") return;
  if (m.error_code === "MP_CHAT_COOLDOWN") return;
  const rawMsg = m.message || "Server error.";
  const code = m.error_code ?? null;
  const friendly =
    code === "MP_CHAT_COOLDOWN"
      ? "You are sending chat messages too quickly. Wait a moment and try again."
      : code === "RATE_LIMITED"
        ? "Too many actions in a short time. Wait a few seconds and try again."
        : code === "BAD_JSON" || code === "BAD_MESSAGE_SHAPE"
          ? "The app sent an invalid message. Try refreshing the page."
          : code === "MP_LOBBY_NOT_JOINABLE"
            ? "That lobby is no longer open for joining — the match may have started or the lobby filled."
            : `The server could not complete that action: ${rawMsg}`;
  const extraLines = [`Server message: ${rawMsg}`];
  showAppError({
    message: friendly,
    hint: "If this keeps happening, copy the details and send them to the developer.",
    errorRef: m.error_ref ?? null,
    errorCode: code,
    source: "server",
    extraLines,
  });
}
