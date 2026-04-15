/**
 * Pre-game room: roster, ready up, host starts → cook.
 */
import { notifyMpServerError } from "../errorToast.js";
import { dismissServerRestartingWait } from "../serverRestartOverlay.js";
import { applyMatchResyncFromPayload, mergeMatchResyncIntoLobby } from "../mpMatchResync.js";
import { runMpWsReconnect } from "../mpReconnect.js";
import { clearMpSeat, saveMpSeat } from "../mpSeatStorage.js";
import {
  navigateToMenuAfterLobbyDissolved,
  notifyMpPlayerJoin,
  notifyMpPlayerLeave,
  showKickedFromMatchToast,
} from "../mpPresenceToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { escapeHtml, rankBadgeHtml } from "../rankUi.js";
import { supporterDisplayNameInnerHtml } from "../supporters.js";
import {
  clearMpChatSession,
  ingestMpChatMessage,
  mountMpChat,
  mpChatHandleErrorPayload,
} from "../mpChat.js";
import { playSfxBeatBattle, playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountCookScreen } from "./cook.js";

/**
 * @param {HTMLElement} root
 * @param {object} lobby
 * @param {string} selfId
 * @param {null | { step?: number; total?: number; message?: string; percent?: number }} kitProgress
 * @param {boolean} settingsPanelOpen
 */
function renderLobby(root, lobby, selfId, kitProgress, settingsPanelOpen) {
  const players = lobby.players || [];
  const hostId = lobby.host_id || "";
  const isHost = Boolean(selfId && hostId && selfId === hostId);
  const cookMin = Number(lobby.cook_duration_min) || 10;
  const anonymousVoting = Boolean(lobby.anonymous_voting);
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
  const lobbyState = String(lobby.state ?? "");
  const canKick = isHost && !generating && lobbyState === "lobby";

  const rows = players
    .map((p) => {
      const pid = String(p.id ?? "");
      const isSelf = Boolean(selfId && pid === String(selfId));
      const kickSlot =
        canKick && !isSelf
          ? `<span class="lobby-kick-slot">
        <button type="button" class="lobby-kick-btn" data-kick-id="${escapeHtml(pid)}" aria-label="Kick">−</button>
        <span class="lobby-kick-tip" role="tooltip">Kick</span>
      </span>`
          : "";
      const nameWrapClass =
        kickSlot !== "" ? "lobby-row-name-wrap lobby-row-name-wrap--kick-hover" : "lobby-row-name-wrap";
      return `
    <div class="lobby-row${kickSlot !== "" ? " lobby-row--kickable" : ""}">
      <div class="${nameWrapClass}">
        ${kickSlot}
        <span class="lobby-name name-with-rank">${rankBadgeHtml(p.rank)}${supporterDisplayNameInnerHtml(p.name)}${p.id === hostId ? " · host" : ""}</span>
      </div>
      <span class="lobby-ready">${p.ready ? "✔" : ""}</span>
    </div>
  `;
    })
    .join("");

  const selfReady = Boolean(selfId && players.some((p) => String(p.id) === String(selfId) && p.ready));

  const hostSettings =
    isHost && !generating
      ? `
    <details class="lobby-settings"${settingsPanelOpen ? " open" : ""}>
      <summary class="lobby-settings-summary">
        <span>Lobby settings</span>
        <span class="lobby-settings-chevron" aria-hidden="true"></span>
      </summary>
      <div class="lobby-settings-body">
        <div class="lobby-settings-field">
          <label class="arcade-label lobby-settings-label" for="cook-duration-select">Cook time</label>
          <select id="cook-duration-select" class="arcade-select lobby-settings-select" aria-label="Cook duration in minutes">
            <option value="5"${cookMin === 5 ? " selected" : ""}>5 min</option>
            <option value="10"${cookMin === 10 ? " selected" : ""}>10 min</option>
            <option value="15"${cookMin === 15 ? " selected" : ""}>15 min</option>
            <option value="20"${cookMin === 20 ? " selected" : ""}>20 min</option>
            <option value="30"${cookMin === 30 ? " selected" : ""}>30 min</option>
          </select>
        </div>
        <label class="lobby-settings-toggle">
          <input type="checkbox" id="lobby-anonymous-voting"${anonymousVoting ? " checked" : ""} />
          <span class="lobby-settings-toggle-text">Anonymous voting</span>
        </label>
      </div>
    </details>
  `
      : "";

  root.innerHTML = `
    <div class="screen lobby arcade-panel">
      <h2 class="arcade-heading">LOBBY <span class="lobby-id">${escapeHtml(lobby.lobby_id || "")}</span></h2>
      <p class="arcade-hint">Spice ${lobby.spice} · ${lobby.is_public ? "Public" : "Code only"} · min 2 players · max 10${
    anonymousVoting ? " · anonymous voting" : ""
  } · all ready · cook ${cookMin} min</p>
      ${hostSettings}
      <div class="lobby-list">${rows}</div>
      <p class="arcade-error" id="lobby-err"></p>
      <div class="arcade-actions"${generating ? ' hidden' : ""}>
        <button type="button" class="arcade-btn arcade-btn-primary" id="btn-ready"${
          selfReady ? " disabled" : ""
        }>READY</button>
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
  let ws = ctx.mpWs;
  const playerId = ctx.playerId;
  let lobby = ctx.lobby;
  /** @type {null | { step?: number; total?: number; message?: string; percent?: number }} */
  let kitProgress = null;
  let preserveWs = false;
  let intentionalLeave = false;
  /** Persists across re-renders when the host expands/collapses settings */
  let lobbySettingsOpen = false;

  const paint = () => renderLobby(root, lobby, playerId, kitProgress, lobbySettingsOpen);

  const errEl = () => root.querySelector("#lobby-err");

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
    return () => {};
  }

  mountAuthCornerLeave(ctx);
  let unmountMpChat = mountMpChat({ ws, getWs: () => ctx.mpWs, playerId });

  const onMessage = async (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "connected") return;
    if (m.type === "match_resync") {
      const nav = await applyMatchResyncFromPayload(ctx, m, "lobby");
      if (!nav) {
        lobby = mergeMatchResyncIntoLobby(m, lobby);
        paint();
      }
      return;
    }
    ingestMpChatMessage(m);
    if (m.type === "kit_progress") {
      kitProgress = m;
      paint();
    }
    notifyMpPlayerJoin(m, playerId);
    notifyMpPlayerLeave(m, playerId);
    if (m.type === "kicked_from_lobby") {
      intentionalLeave = true;
      clearMpSeat();
      showKickedFromMatchToast();
      clearMpChatSession();
      try {
        ctx.mpWs.close();
      } catch {
        /* ignore */
      }
      import("./modeSelect.js").then((mod) => ctx.navigate(mod.mountModeSelectScreen));
      return;
    }
    if (m.type === "lobby_update" && m.lobby) {
      lobby = m.lobby;
      const lid = String(m.lobby.lobby_id || "").trim();
      if (lid) saveMpSeat(lid, String(playerId));
      if (m.lobby.state !== "generating") kitProgress = null;
      paint();
    }
    if (m.type === "player_ready") {
      /* lobby_update follows */
    }
    if (m.type === "error") {
      mpChatHandleErrorPayload(m);
      if (m.error_code !== "MP_CHAT_COOLDOWN") {
        const e = errEl();
        if (e) e.textContent = m.message || "Error";
      }
      notifyMpServerError(m);
    }
    if (m.type === "lobby_dissolved") {
      intentionalLeave = true;
      clearMpSeat();
      void navigateToMenuAfterLobbyDissolved(ctx, ctx.mpWs, m);
      return;
    }
    if (m.type === "start_game") {
      playSfxBeatBattle();
      preserveWs = true;
      if (m.lobby_id) saveMpSeat(String(m.lobby_id), String(playerId));
      ctx.navigate(mountCookScreen, {
        mpWs: ctx.mpWs,
        playerId,
        lobbyId: m.lobby_id,
        seed: m.seed,
        spice: m.spice,
        sounds: m.sounds,
        cookDurationMin: m.cook_duration_min ?? 10,
      });
    }
  };

  const attachReconnectClose = (sock) => {
    sock.addEventListener(
      "close",
      (ev) => {
        if (preserveWs || intentionalLeave) return;
        dismissServerRestartingWait();
        void runMpWsReconnect(ev, {
          ctx,
          intentionalLeave: () => intentionalLeave,
          preserveWs: () => preserveWs,
          onReplaceSocket: (nw) => {
            ws = nw;
            ctx.mpWs = nw;
            unmountMpChat();
            unmountMpChat = mountMpChat({ ws: nw, getWs: () => ctx.mpWs, playerId, continueSession: true });
            nw.onmessage = onMessage;
            attachReconnectClose(nw);
          },
        });
      },
      { once: true },
    );
  };
  attachReconnectClose(ws);

  ws.onmessage = onMessage;

  const changeHandler = (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.id === "lobby-anonymous-voting") {
      playSfxMinor();
      if (ctx.mpWs.readyState !== WebSocket.OPEN) {
        const err = errEl();
        if (err) err.textContent = "Not connected.";
        t.checked = !t.checked;
        return;
      }
      try {
        ctx.mpWs.send(
          JSON.stringify({
            type: "set_anonymous_voting",
            anonymous_voting: t.checked,
          }),
        );
      } catch {
        t.checked = !t.checked;
      }
      return;
    }
    if (!(t instanceof HTMLSelectElement) || t.id !== "cook-duration-select") return;
    playSfxMinor();
    if (ctx.mpWs.readyState !== WebSocket.OPEN) {
      const err = errEl();
      if (err) err.textContent = "Not connected.";
      return;
    }
    try {
      ctx.mpWs.send(
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
    const kickBtn = origin?.closest?.(".lobby-kick-btn");
    if (kickBtn instanceof HTMLButtonElement) {
      const tid = kickBtn.dataset.kickId;
      if (!tid) return;
      playSfxMinor();
      if (ctx.mpWs.readyState !== WebSocket.OPEN) {
        const err = errEl();
        if (err) err.textContent = "Not connected.";
        return;
      }
      try {
        ctx.mpWs.send(JSON.stringify({ type: "kick_player", target_player_id: tid }));
      } catch {
        /* ignore */
      }
      return;
    }
    const btn = origin?.closest?.("#btn-ready, #btn-leave");
    if (!btn) return;

    if (btn.id === "btn-ready") {
      const pl = lobby.players || [];
      if (pl.some((p) => String(p.id) === String(playerId) && p.ready)) return;
      if (/** @type {HTMLButtonElement} */ (btn).disabled) return;
      playSfxMajor();
      if (ctx.mpWs.readyState !== WebSocket.OPEN) {
        const err = errEl();
        if (err) err.textContent = "Not connected. Leave and rejoin.";
        return;
      }
      try {
        ctx.mpWs.send(JSON.stringify({ type: "player_ready" }));
      } catch {
        /* keep button usable — lobby state unchanged */
      }
      return;
    }

    if (btn.id === "btn-leave") {
      playSfxMinor();
      intentionalLeave = true;
      clearMpChatSession();
      clearMpSeat();
      try {
        if (ctx.mpWs.readyState === WebSocket.OPEN) {
          ctx.mpWs.send(JSON.stringify({ type: "leave_lobby" }));
        }
      } catch {
        /* ignore */
      }
      try {
        ctx.mpWs.close();
      } catch {
        /* ignore */
      }
      import("./modeSelect.js").then((mod) => ctx.navigate(mod.mountModeSelectScreen));
    }
  };
  const toggleHandler = (e) => {
    const t = e.target;
    if (t instanceof HTMLDetailsElement && t.classList.contains("lobby-settings")) {
      lobbySettingsOpen = t.open;
    }
  };

  root.addEventListener("click", clickHandler);
  root.addEventListener("change", changeHandler);
  root.addEventListener("toggle", toggleHandler);

  const initialLid = String(lobby?.lobby_id || "").trim();
  if (initialLid) saveMpSeat(initialLid, String(playerId));

  paint();

  return () => {
    intentionalLeave = true;
    if (!preserveWs) {
      clearMpChatSession();
    }
    unmountMpChat();
    root.removeEventListener("click", clickHandler);
    root.removeEventListener("change", changeHandler);
    root.removeEventListener("toggle", toggleHandler);
    root.innerHTML = "";
    if (!preserveWs) {
      try {
        ctx.mpWs.close();
      } catch {
        /* ignore */
      }
    }
  };
}
