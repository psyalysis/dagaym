/**
 * Queue up: WS create or join, then you land in the lobby.
 */
import { getUsername, validateSession } from "../authApi.js";
import { getWsUrl } from "../apiOrigin.js";
import { fetchPublicLobbyJoinable } from "../publicLobbyApi.js";
import {
  notifyMpServerError,
  setAppErrorContext,
  showAppError,
} from "../errorToast.js";
import { showServerRestartingWait } from "../serverRestartOverlay.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { mountLobbyScreen } from "./lobby.js";

export function mountMatchmakingScreen(root, ctx) {
  const flow =
    ctx.lobbyFlow ||
    (ctx.lobbyCode ? "join_code" : ctx.joinLobbyId ? "join_id" : "create");
  const phaseLabel =
    flow === "create"
      ? "Creating lobby"
      : flow === "join_id"
        ? "Joining from server list"
        : "Joining with code";
  setAppErrorContext({ screen: "Matchmaking", phase: phaseLabel });

  const name = (ctx.username || ctx.mpName || getUsername() || "Player").trim();
  const spices =
    Array.isArray(ctx.mpSpices) && ctx.mpSpices.length > 0
      ? ctx.mpSpices
      : [0.25, 0.5, 0.85];
  const isPublic = ctx.isPublic !== false;
  const mpGenre = ctx.mpGenre === "edm" ? "edm" : "trap";
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
  /** Lobby owns the socket now — don't close it when this screen unmounts. */
  let handedOffWs = false;

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };

  const failWithToast = (msg, code, hint) => {
    setStatus(msg);
    showAppError({
      message: msg,
      errorCode: code ?? null,
      hint: hint ?? undefined,
    });
  };

  void (async () => {
    const ok = await validateSession();
    if (cancelled) return;
    if (!ok) {
      failWithToast(
        "Your login session expired. Sign in again, then try creating or joining a lobby.",
        "SESSION",
        "Use the menu to log in if you see a guest screen.",
      );
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
      failWithToast(
        "Could not connect to the game server.",
        "WS_ERROR",
        "If you are running the game locally, start the backend. Otherwise wait a moment and try again.",
      );
    };

    ws.onclose = (ev) => {
      if (handedOffWs) return;
      if (ev.code === 4401) {
        failWithToast(
          "You are not logged in, or your session expired.",
          "WS_4401",
          "Sign in from the main menu and open multiplayer again.",
        );
        return;
      }
      if (ev.code === 1006 || ev.code === 1012) {
        setStatus("Server is restarting… please wait!");
        showServerRestartingWait();
        return;
      }
      failWithToast(
        "The connection closed before you reached the lobby.",
        `WS_CLOSE_${ev.code}`,
        "Try again. If it keeps happening, refresh the page.",
      );
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
              genre: mpGenre,
            }),
          );
        } else if (flow === "join_id" && joinLobbyId) {
          void (async () => {
            const ok = await fetchPublicLobbyJoinable(joinLobbyId);
            if (cancelled || !ws) return;
            if (!ok) {
              handedOffWs = true;
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              failWithToast(
                "That lobby closed before you joined. Open the server list and try again.",
                "MM_STALE_LOBBY",
                "The list updates often; pick a lobby and join right away.",
              );
              return;
            }
            ws.send(
              JSON.stringify({
                type: "join_lobby",
                name,
                lobby_id: joinLobbyId,
              }),
            );
          })();
        } else if (lobbyCode) {
          ws?.send(
            JSON.stringify({ type: "join_lobby", name, lobby_code: lobbyCode }),
          );
        } else {
          failWithToast(
            "The app could not find a lobby to join (missing id or code).",
            "MM_CONFIG",
            "Go back and pick a server, or enter a lobby code.",
          );
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
