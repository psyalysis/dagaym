/**
 * MP chat: one scrollback, one input bar. ASCII only + a handful of emoji shortcuts.
 */
import { escapeHtml } from "./rankUi.js";
import { subscribeSupporterList, supporterDisplayNameInnerHtml } from "./supporters.js";
import { playSfxMinor } from "./sfx.js";

const BUFFER_MAX = 50;
const COOLDOWN_MS = 3000;
const MAX_LEN = 300;

/** @type {{ key: string, char: string }[]} */
const QUICK_EMOJIS = [
  { key: "wave", char: "👋" },
  { key: "fire", char: "🔥" },
  { key: "heart", char: "❤️" },
  { key: "skull", char: "💀" },
  { key: "hundred", char: "💯" },
];

const URL_SCHEMES = /(?:https?|ftp):\/\//i;
const WWW = /\bwww\./i;
const HOST_TLD =
  /\b[a-z0-9][a-z0-9.-]*\.(?:com|net|org|io|gg|co|dev|app|tv|me|ai|ly|uk|us|eu|de|fr|ca)\b/i;

/** @type {Array<{ name: string, playerId: string, text?: string, emoji?: string, emojiChar?: string }>} */
let sessionLog = [];

/** @type {Set<() => void>} */
const logSubscribers = new Set();

let outgoingCooldownUntil = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let cooldownIntervalId = null;

function emojiCharForKey(key) {
  const row = QUICK_EMOJIS.find((e) => e.key === key);
  return row ? row.char : key;
}

function textHasBlockedUrl(s) {
  return URL_SCHEMES.test(s) || WWW.test(s) || HOST_TLD.test(s);
}

function stripToAsciiPrintable(s) {
  return [...String(s)]
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c !== undefined && c >= 0x20 && c <= 0x7e;
    })
    .join("");
}

function pushSessionLine(line) {
  sessionLog.push(line);
  while (sessionLog.length > BUFFER_MAX) sessionLog.shift();
  logSubscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

/** New queue / new lobby — flush the old messages. */
export function clearMpChatSession() {
  sessionLog.length = 0;
  logSubscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

/**
 * After you JSON.parse the WS payload — we only react to mp_chat here.
 * @param {any} m
 */
export function ingestMpChatMessage(m) {
  if (!m || m.type !== "mp_chat") return;
  const name = m.name != null ? String(m.name) : "Player";
  const pid = m.player_id != null ? String(m.player_id) : "";
  if (m.text != null && String(m.text).length > 0) {
    pushSessionLine({ name, playerId: pid, text: String(m.text) });
    return;
  }
  if (m.emoji != null && String(m.emoji).length > 0) {
    const key = String(m.emoji);
    pushSessionLine({
      name,
      playerId: pid,
      emoji: key,
      emojiChar: emojiCharForKey(key),
    });
  }
}

/**
 * Server said you're chatting too fast — sync the cooldown UI.
 * @param {any} m
 */
export function mpChatHandleErrorPayload(m) {
  if (!m || m.type !== "error" || m.error_code !== "MP_CHAT_COOLDOWN") return;
  outgoingCooldownUntil = Date.now() + COOLDOWN_MS;
  logSubscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

function renderLogEl(logEl) {
  if (!logEl) return;
  const lines = sessionLog
    .map((row) => {
      const who = supporterDisplayNameInnerHtml(row.name);
      if (row.text != null) {
        return `<div class="mp-chat-line"><span class="mp-chat-who">${who}</span><span class="mp-chat-text">${escapeHtml(row.text)}</span></div>`;
      }
      const ch = row.emojiChar ? escapeHtml(row.emojiChar) : "";
      return `<div class="mp-chat-line mp-chat-line--emoji"><span class="mp-chat-who">${who}</span><span class="mp-chat-emoji" aria-hidden="true">${ch}</span></div>`;
    })
    .join("");
  logEl.innerHTML = lines || `<p class="mp-chat-empty arcade-hint">No messages yet.</p>`;
  logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Drop the chat UI on the screen; cleanup fn tears it down.
 * @param {{ ws: WebSocket, getWs?: () => WebSocket, playerId: string, continueSession?: boolean }} opts
 * @returns {() => void}
 */
export function mountMpChat({ ws, getWs, playerId, continueSession = false }) {
  void playerId;
  const activeWs = typeof getWs === "function" ? getWs : () => ws;
  if (!continueSession) {
    clearMpChatSession();
  }
  const wrap = document.createElement("div");
  wrap.className = "mp-chat";
  wrap.setAttribute("aria-label", "Match chat");
  wrap.innerHTML = `
    <div class="mp-chat-inner">
      <p class="mp-chat-label arcade-label">Chat</p>
      <div class="mp-chat-log" id="mp-chat-log" role="log" aria-live="polite" aria-relevant="additions"></div>
      <p class="mp-chat-err arcade-error" id="mp-chat-err" hidden></p>
      <div class="mp-chat-composer">
        <input type="text" class="arcade-input mp-chat-input" id="mp-chat-input" maxlength="${MAX_LEN}" autocomplete="off" placeholder="Message" aria-label="Chat message" />
        <button type="button" class="arcade-btn arcade-btn-primary mp-chat-send" id="mp-chat-send">Send</button>
      </div>
      <div class="mp-chat-quick" aria-label="Quick reactions"></div>
    </div>
  `;
  document.body.appendChild(wrap);
  document.body.classList.add("mp-chat-open");

  const logEl = wrap.querySelector("#mp-chat-log");
  const input = wrap.querySelector("#mp-chat-input");
  const sendBtn = wrap.querySelector("#mp-chat-send");
  const errEl = wrap.querySelector("#mp-chat-err");
  const quickEl = wrap.querySelector(".mp-chat-quick");

  for (const { key, char } of QUICK_EMOJIS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lobby-emoji-btn mp-chat-emoji-btn";
    b.dataset.mpChatEmoji = key;
    b.setAttribute("aria-label", `Send ${key}`);
    b.textContent = char;
    quickEl?.appendChild(b);
  }

  const showErr = (msg) => {
    if (!errEl) return;
    if (!msg) {
      errEl.hidden = true;
      errEl.textContent = "";
      return;
    }
    errEl.hidden = false;
    errEl.textContent = msg;
    window.setTimeout(() => {
      if (errEl.textContent === msg) showErr("");
    }, 4000);
  };

  const refreshCooldownUi = () => {
    const cooling = Date.now() < outgoingCooldownUntil;
    if (input instanceof HTMLInputElement) input.disabled = cooling;
    if (sendBtn instanceof HTMLButtonElement) {
      sendBtn.disabled = cooling;
      sendBtn.textContent = cooling ? "Wait…" : "Send";
    }
    wrap.querySelectorAll("[data-mp-chat-emoji]").forEach((el) => {
      if (el instanceof HTMLButtonElement) el.disabled = cooling;
      if (cooling) el.classList.add("lobby-emoji-btn--cooldown");
      else el.classList.remove("lobby-emoji-btn--cooldown");
    });
  };

  const startCooldown = () => {
    outgoingCooldownUntil = Date.now() + COOLDOWN_MS;
    refreshCooldownUi();
    if (cooldownIntervalId != null) clearInterval(cooldownIntervalId);
    cooldownIntervalId = window.setInterval(() => {
      if (Date.now() >= outgoingCooldownUntil) {
        if (cooldownIntervalId != null) clearInterval(cooldownIntervalId);
        cooldownIntervalId = null;
        refreshCooldownUi();
      }
    }, 200);
  };

  const redraw = () => {
    renderLogEl(logEl instanceof HTMLElement ? logEl : null);
    refreshCooldownUi();
  };

  logSubscribers.add(redraw);
  const unsubSupporters = subscribeSupporterList(redraw);
  redraw();

  if (input instanceof HTMLInputElement) {
    input.addEventListener("input", () => {
      const cleaned = stripToAsciiPrintable(input.value);
      if (cleaned !== input.value) input.value = cleaned;
      showErr("");
    });
  }

  const trySendText = () => {
    showErr("");
    const sock = activeWs();
    if (!(input instanceof HTMLInputElement) || sock.readyState !== WebSocket.OPEN) return;
    const t = input.value.trim();
    if (!t) return;
    if (t.length > MAX_LEN) {
      showErr("Message too long.");
      return;
    }
    if (textHasBlockedUrl(t)) {
      showErr("URLs are not allowed.");
      return;
    }
    if (Date.now() < outgoingCooldownUntil) return;
    playSfxMinor();
    try {
      sock.send(JSON.stringify({ type: "mp_chat", text: t }));
      input.value = "";
      startCooldown();
    } catch {
      showErr("Could not send.");
    }
  };

  sendBtn?.addEventListener("click", () => {
    trySendText();
  });

  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      trySendText();
    }
  });

  wrap.addEventListener("click", (e) => {
    const t = e.target;
    const btn = t instanceof Element ? t.closest("[data-mp-chat-emoji]") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const key = btn.dataset.mpChatEmoji;
    const sock = activeWs();
    if (!key || sock.readyState !== WebSocket.OPEN) return;
    if (Date.now() < outgoingCooldownUntil) return;
    showErr("");
    playSfxMinor();
    try {
      sock.send(JSON.stringify({ type: "mp_chat", emoji: key }));
      startCooldown();
    } catch {
      showErr("Could not send.");
    }
  });

  return () => {
    unsubSupporters();
    logSubscribers.delete(redraw);
    document.body.classList.remove("mp-chat-open");
    wrap.remove();
    if (cooldownIntervalId != null) {
      clearInterval(cooldownIntervalId);
      cooldownIntervalId = null;
    }
  };
}
