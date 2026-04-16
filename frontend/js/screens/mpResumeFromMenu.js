/**
 * Resume WebSocket from main menu via resume_player_id; match_resync routes to phase.
 */
import { getWsUrl } from "../apiOrigin.js";
import { getUsername, validateSession } from "../authApi.js";
import { applyMatchResyncFromPayload } from "../mpMatchResync.js";
import { clearReconnectSuppress } from "../mpReconnectPending.js";
import { setAppErrorContext, showAppError } from "../errorToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { mountMultiplayerHubScreen } from "./multiplayerHub.js";

const DEFAULT_SPICES = [0.25, 0.5, 0.85];

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 */
export function mountMpResumeFromMenuScreen(root, ctx) {
  const pending = ctx.mpReconnectPending;
  if (!pending || !pending.player_id || !pending.lobby_id) {
    queueMicrotask(() => ctx.navigate(mountMultiplayerHubScreen));
    return () => {};
  }

  setAppErrorContext({ screen: "Reconnect", phase: "Resuming from menu" });
  mountAuthCornerLeave(ctx);
  root.innerHTML = `
    <div class="screen matchmaking arcade-panel screen--vert-center">
      <h2 class="arcade-heading">RECONNECTING</h2>
      <p class="arcade-status" id="mp-resume-status">Restoring session…</p>
    </div>
  `;
  const statusEl = root.querySelector("#mp-resume-status");

  let cancelled = false;
  /** @type {WebSocket | null} */
  let ws = null;
  /** Set before ctx.navigate from match_resync so unmount does not close the live socket (same as matchmaking handedOffWs). */
  let handedOffWs = false;

  void (async () => {
    const ok = await validateSession();
    if (cancelled) return;
    if (!ok) {
      ctx.navigate(mountMultiplayerHubScreen);
      return;
    }

    const displayName = (ctx.username || getUsername() || "Player").trim();
    ctx.lobbyId = pending.lobby_id;
    ctx.playerId = pending.player_id;
    ctx.mpName = displayName;
    ctx.username = displayName;
    if (!Array.isArray(ctx.mpSpices) || ctx.mpSpices.length === 0) {
      ctx.mpSpices = DEFAULT_SPICES;
    }

    try {
      ws = new WebSocket(getWsUrl({ resumePlayerId: pending.player_id }));
    } catch {
      if (statusEl) statusEl.textContent = "Could not connect.";
      showAppError({
        message: "Could not open a connection to resume your match.",
        hint: "Return to multiplayer from the main menu and try again.",
        errorCode: "MP_RESUME_WS",
      });
      queueMicrotask(() => ctx.navigate(mountMultiplayerHubScreen));
      return;
    }

    ctx.mpWs = ws;

    let sawConnected = false;

    ws.onmessage = async (ev) => {
      if (cancelled || handedOffWs) return;
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "connected") {
        sawConnected = true;
        if (m.player_id) ctx.playerId = String(m.player_id);
        return;
      }
      if (m.type === "match_resync") {
        ctx.mpWs = ws;
        // navigate() runs synchronously inside applyMatchResync → unmount runs → cleanup must NOT close ws.
        handedOffWs = true;
        if (ws) ws.onclose = null;
        try {
          const done = await applyMatchResyncFromPayload(ctx, m, "menu_resume");
          if (done) {
            clearReconnectSuppress();
          } else {
            handedOffWs = false;
            if (statusEl) statusEl.textContent = "Could not restore match state.";
            showAppError({
              message: "The server could not restore your match state.",
              hint: "Try multiplayer again from the main menu. The match may have ended.",
              errorCode: "MP_RESUME_SYNC",
            });
            try {
              ws?.close();
            } catch {
              /* ignore */
            }
            queueMicrotask(() => ctx.navigate(mountMultiplayerHubScreen));
          }
        } catch {
          handedOffWs = false;
          if (statusEl) statusEl.textContent = "Could not restore match state.";
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
          queueMicrotask(() => ctx.navigate(mountMultiplayerHubScreen));
        }
      }
    };

    ws.onerror = () => {
      if (cancelled || handedOffWs) return;
      if (statusEl) statusEl.textContent = "Connection error.";
    };

    ws.onclose = (ev) => {
      if (cancelled || handedOffWs) return;
      if (ev.code === 4404 || ev.code === 4401) {
        showAppError({
          message:
            ev.code === 4401
              ? "You must be logged in to resume, or your session expired."
              : "This resume link is no longer valid (match may be finished).",
          hint: "Open multiplayer from the home screen and join or host again.",
          errorCode: ev.code === 4401 ? "MP_RESUME_4401" : "MP_RESUME_4404",
        });
        ctx.navigate(mountMultiplayerHubScreen);
        return;
      }
      if (!sawConnected) {
        showAppError({
          message: "The connection closed before your session could resume.",
          hint: "Check your network, then try resuming again from the menu.",
          errorCode: `MP_RESUME_${ev.code}`,
        });
        ctx.navigate(mountMultiplayerHubScreen);
      }
    };
  })();

  return () => {
    cancelled = true;
    root.innerHTML = "";
    if (ws && !handedOffWs && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}
