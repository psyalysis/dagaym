/**
 * Matchmaking — WebSocket: create_lobby or join_lobby → lobby_update → Lobby.
 */
import { getUsername, validateSession } from "../authApi.js";
import { getWsUrl } from "../apiOrigin.js";
import { notifyMpServerError, showAppError } from "../errorToast.js";
import { showServerRestartingWait } from "../serverRestartOverlay.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { mountLobbyScreen } from "./lobby.js";

export function mountMatchmakingScreen(root, ctx) {
  const name = (ctx.username || ctx.mpName || getUsername() || "Player").trim();
  const flow =
    ctx.lobbyFlow || (ctx.lobbyCode ? "join_code" : ctx.joinLobbyId ? "join_id" : "create");
  const spices =
    Array.isArray(ctx.mpSpices) && ctx.mpSpices.length > 0
      ? ctx.mpSpices
      : [0.25, 0.5, 0.85];
  const isPublic = ctx.isPublic !== false;
  const joinLobbyId = ctx.joinLobbyId ? String(ctx.joinLobbyId).trim() : "";
  const lobbyCode = ctx.lobbyCode
    ? String(ctx.lobbyCode)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "")
        .replace(/[-_]/g, "")
    : "";

  let title = "CONNECTING";
  let hint = "";
  if (flow === "create") {
    title = "CREATE LOBBY";
    hint = isPublic
      ? "Public — others can join from the server browser"
      : "Code only — share the lobby code to invite players";
  } else if (flow === "join_id") {
    title = "JOIN LOBBY";
    hint = "Joining from server list…";
  } else {
    title = "JOIN LOBBY";
    hint = lobbyCode ? `Code ${lobbyCode} · pre-game only` : "";
  }

  mountAuthCornerLeave(ctx);

  root.innerHTML = `
    <div class="screen matchmaking arcade-panel">
      <h2 class="arcade-heading">${title}</h2>
      <p class="arcade-status" id="mm-status">Connecting…</p>
      <p class="arcade-hint" id="mm-hint">${hint}</p>
    </div>
  `;
  const statusEl = root.querySelector("#mm-status");

  let cancelled = false;
  /** @type {WebSocket | null} */
  let ws = null;
  /** When true, WebSocket is passed to Lobby — do not close on unmount. */
  let handedOffWs = false;

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };

  const failWithToast = (msg, code) => {
    setStatus(msg);
    showAppError({ message: msg, errorCode: code ?? null });
  };

  void (async () => {
    const ok = await validateSession();
    if (cancelled) return;
    if (!ok) {
      failWithToast("Session expired. Please log in again.", "SESSION");
      return;
    }

    ws = new WebSocket(getWsUrl());

    ws.onopen = () => {
      if (cancelled) return;
      if (statusEl) {
        if (flow === "create") statusEl.textContent = "Creating lobby…";
        else if (flow === "join_id") statusEl.textContent = "Joining…";
        else statusEl.textContent = "Joining lobby…";
      }
    };

    ws.onerror = () => {
      failWithToast("WebSocket error. Is the server running?", "WS_ERROR");
    };

    ws.onclose = (ev) => {
      if (handedOffWs) return;
      if (ev.code === 4401) {
        failWithToast("Session expired or not logged in. Please log in again.", "WS_4401");
        return;
      }
      if (ev.code === 1006 || ev.code === 1012) {
        setStatus("Server is restarting… please wait!");
        showServerRestartingWait();
        return;
      }
      failWithToast("Connection closed. Try again.", `WS_CLOSE_${ev.code}`);
    };

    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "connected") {
        ctx.playerId = m.player_id;
        if (flow === "create") {
          ws?.send(
            JSON.stringify({
              type: "create_lobby",
              name,
              spices,
              is_public: isPublic,
            }),
          );
        } else if (flow === "join_id" && joinLobbyId) {
          ws?.send(JSON.stringify({ type: "join_lobby", name, lobby_id: joinLobbyId }));
        } else if (lobbyCode) {
          ws?.send(JSON.stringify({ type: "join_lobby", name, lobby_code: lobbyCode }));
        } else {
          failWithToast("Missing lobby id or code.", "MM_CONFIG");
        }
        return;
      }
      if (m.type === "lobby_update" && m.lobby) {
        handedOffWs = true;
        if (ws) ws.onclose = null;
        ctx.navigate(mountLobbyScreen, {
          mpWs: ws,
          mpName: name,
          mpSpices: spices,
          lobbyCode: flow === "join_code" ? lobbyCode : null,
          playerId: ctx.playerId,
          lobby: m.lobby,
        });
        return;
      }
      if (m.type === "error") {
        setStatus(m.message || "Error");
        notifyMpServerError(m);
      }
    };
  })();

  return () => {
    root.innerHTML = "";
    cancelled = true;
    if (ws && !handedOffWs) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}
