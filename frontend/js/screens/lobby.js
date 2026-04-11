/**
 * LobbyScreen — player list, ready, start_game → Cook.
 */
import { mountAuthCornerLeave } from "../authCorner.js";
import { escapeHtml, rankBadgeHtml } from "../rankUi.js";
import { playSfxBeatBattle, playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountCookScreen } from "./cook.js";

/** @type {Record<string, string>} */
const LOBBY_EMOJI_CHARS = {
  wave: "👋",
  thumbs_up: "👍",
  fire: "🔥",
  clap: "👏",
  heart: "❤️",
};

const LOBBY_EMOJI_KEYS = Object.keys(LOBBY_EMOJI_CHARS);

/** @type {Record<string, string>} */
const LOBBY_EMOJI_ARIA = {
  wave: "Wave hello",
  thumbs_up: "Thumbs up",
  fire: "Fire",
  clap: "Clap",
  heart: "Heart",
};

/**
 * @param {string} name
 * @param {string} emojiKey
 */
function lobbyEmojiLineHtml(name, emojiKey) {
  const esc = escapeHtml(name);
  if (emojiKey === "wave") {
    return `<p class="lobby-chat-line"><em class="lobby-chat-name">${esc}</em> waved! <span class="lobby-chat-emoji" aria-hidden="true">${LOBBY_EMOJI_CHARS.wave}</span></p>`;
  }
  const ch = LOBBY_EMOJI_CHARS[emojiKey] || "·";
  return `<p class="lobby-chat-line"><em class="lobby-chat-name">${esc}</em> <span class="lobby-chat-emoji" aria-hidden="true">${ch}</span></p>`;
}

/**
 * @param {string[]} linesHtml
 */
function renderLobby(root, lobby, selfId, kitProgress, linesHtml) {
  const players = lobby.players || [];
  const hostId = lobby.host_id || "";
  const isHost = Boolean(selfId && hostId && selfId === hostId);
  const cookMin = Number(lobby.cook_duration_min) || 10;
  const generating = lobby.state === "generating" || kitProgress != null;
  const pct = generating ? Math.min(100, Number(kitProgress?.percent) || 0) : 0;
  const kitMsg = kitProgress?.message || "Preparing kit…";
  const step = kitProgress?.step ?? 0;
  const total = kitProgress?.total ?? 11;
  const label = kitProgress?.label;
  const stepLine =
    label && step > 0
      ? `${step} / ${total} — ${String(label).replace(/_/g, " ")}`
      : `${step} / ${total}`;
  const rows = players
    .map(
      (p) => `
    <div class="lobby-row">
      <span class="lobby-name">${escapeHtml(p.name)}${rankBadgeHtml(p.rank)}${p.id === hostId ? " · host" : ""}</span>
      <span class="lobby-ready">${p.ready ? "✔" : ""}</span>
    </div>
  `,
    )
    .join("");

  const hostDuration = isHost
    ? `
    <div class="host-cook-duration">
      <label class="arcade-label" for="cook-duration-select">Cook time (host)</label>
      <select id="cook-duration-select" class="arcade-select" aria-label="Cook duration in minutes">
        <option value="5"${cookMin === 5 ? " selected" : ""}>5 min</option>
        <option value="10"${cookMin === 10 ? " selected" : ""}>10 min</option>
        <option value="15"${cookMin === 15 ? " selected" : ""}>15 min</option>
        <option value="20"${cookMin === 20 ? " selected" : ""}>20 min</option>
      </select>
    </div>
  `
    : "";

  root.innerHTML = `
    <div class="screen lobby arcade-panel">
      <h2 class="arcade-heading">LOBBY <span class="lobby-id">${escapeHtml(lobby.lobby_id || "")}</span></h2>
      <p class="arcade-hint">Spice ${lobby.spice} · ${lobby.is_public ? "Public" : "Code only"} · min 2 players · all ready · cook ${cookMin} min</p>
      ${hostDuration}
      <div class="lobby-list">${rows}</div>
      ${
        generating
          ? ""
          : `
      <div class="lobby-chat-wrap">
        <p class="arcade-label lobby-chat-label">Quick chat</p>
        <div class="lobby-chat-feed" id="lobby-chat-feed" aria-live="polite">${linesHtml.join("")}</div>
        <div class="lobby-emoji-bar" role="group" aria-label="Send an emoji">
          ${LOBBY_EMOJI_KEYS.map(
            (k) =>
              `<button type="button" class="lobby-emoji-btn" data-lobby-emoji="${k}" aria-label="${LOBBY_EMOJI_ARIA[k] || "Send emoji"}">${LOBBY_EMOJI_CHARS[k]}</button>`,
          ).join("")}
        </div>
      </div>`
      }
      <p class="arcade-error" id="lobby-err"></p>
      <div class="arcade-actions"${generating ? ' hidden' : ""}>
        <button type="button" class="arcade-btn arcade-btn-primary" id="btn-ready">READY</button>
        <button type="button" class="arcade-btn arcade-btn-secondary" id="btn-leave">Leave</button>
      </div>
      ${
        generating
          ? `
      <div class="lobby-kit-overlay" id="lobby-kit-overlay" role="status" aria-live="polite">
        <div class="lobby-kit-overlay-card">
          <p class="arcade-heading lobby-kit-overlay-title">BUILDING KIT</p>
          <p class="arcade-hint lobby-kit-overlay-msg">${escapeHtml(kitMsg)}</p>
          <div class="lobby-kit-progress" aria-hidden="true">
            <div class="lobby-kit-progress-fill" style="width:${pct}%"></div>
          </div>
          <p class="arcade-hint lobby-kit-overlay-step">${escapeHtml(stepLine)}</p>
        </div>
      </div>`
          : ""
      }
    </div>
  `;
  root.dataset.selfId = selfId;
}

export function mountLobbyScreen(root, ctx) {
  const ws = ctx.mpWs;
  const playerId = ctx.playerId;
  let lobby = ctx.lobby;
  /** @type {null | { step?: number; total?: number; message?: string; percent?: number }} */
  let kitProgress = null;
  /** @type {string[]} */
  let chatLinesHtml = [];
  const MAX_LOBBY_CHAT = 10;
  let preserveWs = false;
  let intentionalLeave = false;

  const paint = () => renderLobby(root, lobby, playerId, kitProgress, chatLinesHtml);

  const errEl = () => root.querySelector("#lobby-err");

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
    return () => {};
  }

  mountAuthCornerLeave(ctx);

  const onMessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "kit_progress") {
      kitProgress = m;
      paint();
    }
    if (m.type === "lobby_update" && m.lobby) {
      lobby = m.lobby;
      if (m.lobby.state !== "generating") kitProgress = null;
      paint();
    }
    if (m.type === "player_ready") {
      /* lobby_update follows */
    }
    if (m.type === "lobby_emoji" && m.emoji && m.name) {
      chatLinesHtml = [...chatLinesHtml, lobbyEmojiLineHtml(String(m.name), String(m.emoji))].slice(
        -MAX_LOBBY_CHAT,
      );
      paint();
    }
    if (m.type === "error") {
      const e = errEl();
      if (e) e.textContent = m.message || "Error";
    }
    if (m.type === "lobby_dissolved") {
      intentionalLeave = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      import("./modeSelect.js").then((mod) => ctx.navigate(mod.mountModeSelectScreen));
      return;
    }
    if (m.type === "start_game") {
      playSfxBeatBattle();
      preserveWs = true;
      ctx.navigate(mountCookScreen, {
        mpWs: ws,
        playerId,
        lobbyId: m.lobby_id,
        seed: m.seed,
        spice: m.spice,
        sounds: m.sounds,
        cookDurationMin: m.cook_duration_min ?? 10,
      });
    }
  };

  ws.onclose = () => {
    if (preserveWs || intentionalLeave) return;
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
  };

  ws.onmessage = onMessage;

  const changeHandler = (e) => {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement) || t.id !== "cook-duration-select") return;
    playSfxMinor();
    if (ws.readyState !== WebSocket.OPEN) {
      const err = errEl();
      if (err) err.textContent = "Not connected.";
      return;
    }
    try {
      ws.send(
        JSON.stringify({
          type: "set_cook_duration",
          minutes: parseInt(t.value, 10),
        }),
      );
    } catch {
      /* ignore */
    }
  };

  const clickHandler = (e) => {
    const t = e.target;
    const origin = t instanceof Element ? t : t && "parentElement" in t ? t.parentElement : null;
    const emojiBtn = origin?.closest?.("[data-lobby-emoji]");
    if (emojiBtn instanceof HTMLButtonElement && emojiBtn.dataset.lobbyEmoji) {
      playSfxMinor();
      if (ws.readyState !== WebSocket.OPEN) {
        const err = errEl();
        if (err) err.textContent = "Not connected.";
        return;
      }
      try {
        ws.send(
          JSON.stringify({
            type: "lobby_emoji",
            emoji: emojiBtn.dataset.lobbyEmoji,
          }),
        );
      } catch {
        /* ignore */
      }
      return;
    }
    const btn = origin?.closest?.("#btn-ready, #btn-leave");
    if (!btn) return;

    if (btn.id === "btn-ready") {
      if (/** @type {HTMLButtonElement} */ (btn).disabled) return;
      playSfxMajor();
      if (ws.readyState !== WebSocket.OPEN) {
        const err = errEl();
        if (err) err.textContent = "Not connected. Leave and rejoin.";
        return;
      }
      /** @type {HTMLButtonElement} */ (btn).disabled = true;
      try {
        ws.send(JSON.stringify({ type: "player_ready" }));
      } catch {
        /** @type {HTMLButtonElement} */ (btn).disabled = false;
      }
      return;
    }

    if (btn.id === "btn-leave") {
      playSfxMinor();
      intentionalLeave = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      import("./modeSelect.js").then((mod) => ctx.navigate(mod.mountModeSelectScreen));
    }
  };
  root.addEventListener("click", clickHandler);
  root.addEventListener("change", changeHandler);

  paint();

  return () => {
    intentionalLeave = true;
    root.removeEventListener("click", clickHandler);
    root.removeEventListener("change", changeHandler);
    root.innerHTML = "";
    ws.onclose = null;
    if (!preserveWs) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}
