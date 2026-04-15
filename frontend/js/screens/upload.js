/**
 * Upload phase: pick a beat, hit the server before the timer ghosts you.
 */
import { authHeadersMultipart } from "../authApi.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { notifyMpServerError, showAppError } from "../errorToast.js";
import { dismissServerRestartingWait, showServerRestartingWait } from "../serverRestartOverlay.js";
import { applyMatchResyncFromPayload } from "../mpMatchResync.js";
import { runMpWsReconnect } from "../mpReconnect.js";
import { saveMpSeat } from "../mpSeatStorage.js";
import {
  navigateToMenuAfterLobbyDissolved,
  notifyMpPlayerJoin,
  notifyMpPlayerLeave,
} from "../mpPresenceToast.js";
import { ingestMpChatMessage, mountMpChat, mpChatHandleErrorPayload } from "../mpChat.js";
import {
  applyMatchWsToLobby,
  lobbyLikeFromMatchSync,
  normalizeLobbyLike,
  phaseTimerRowHtml,
  progressHintSlotHtml,
  syncMatchProgressHint,
  updatePhaseTimerBar,
} from "../mpMatchRoster.js";
import { fetchMatchSync, pollMatchSync } from "../mpMatchSync.js";
import { playSfxMajor, playSfxUploadAlarm } from "../sfx.js";
import { mountVotingSlideshowScreen } from "./votingSlideshow.js";

const UPLOAD_WINDOW_SEC = 120;

export function mountUploadScreen(root, ctx) {
  if (!ctx.mpWs || ctx.mpWs.readyState !== WebSocket.OPEN) {
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
    return () => {};
  }
  const playerId = ctx.playerId;
  const lobbyId = ctx.lobbyId;
  const rawDeadline = ctx.uploadDeadlineTs;
  const deadlineTs =
    typeof rawDeadline === "number" && Number.isFinite(rawDeadline)
      ? rawDeadline
      : Date.now() / 1000 + 120;
  let preserveWs = false;
  let httpNavigated = false;
  /** Intentional socket close — skip the "server restarting" overlay. */
  let teardownClose = false;
  let closedNotified = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let tickId = null;

  mountAuthCornerLeave(ctx);
  let unmountMpChat = mountMpChat({
    ws: ctx.mpWs,
    getWs: () => ctx.mpWs,
    playerId,
    continueSession: true,
  });

  const lid0 = String(lobbyId || "").trim();
  const pid0 = String(playerId || "").trim();
  if (lid0 && pid0) saveMpSeat(lid0, pid0);

  root.innerHTML = `
    <div class="screen upload arcade-panel">
      <div class="mp-panel-head">
        <h2 class="arcade-heading mp-panel-head-title">UPLOAD!</h2>
        <div class="mp-panel-head-timer">${phaseTimerRowHtml("mp-upload-phase")}</div>
        <div class="mp-panel-head-roster">${progressHintSlotHtml("mp-corner-upload")}</div>
      </div>
      <p class="arcade-hint">2:00 · MP3 or WAV · max 30MB</p>
      <p class="arcade-hint upload-hint-muted">After time runs out you can still vote and listen, but others won’t hear your beat.</p>
      <form id="upload-form" class="upload-form">
        <input type="file" id="beat-file" accept=".mp3,.wav,audio/mpeg,audio/wav" required />
        <button type="submit" class="arcade-btn arcade-btn-primary" id="upload-submit">Upload</button>
      </form>
      <p class="arcade-status" id="upload-status"></p>
    </div>
  `;

  const form = root.querySelector("#upload-form");
  const statusEl = root.querySelector("#upload-status");
  const uploadTotalSec = UPLOAD_WINDOW_SEC;

  /** @type {ReturnType<typeof normalizeLobbyLike>} */
  let lobbyView = normalizeLobbyLike({});
  const syncProgressHint = () => syncMatchProgressHint(root, "mp-corner-upload", "upload", lobbyView);

  void (async () => {
    const sync = await fetchMatchSync(String(lobbyId));
    const L = lobbyLikeFromMatchSync(sync);
    if (L && Array.isArray(L.players) && L.players.length) {
      lobbyView = normalizeLobbyLike(L);
      syncProgressHint();
    }
  })();

  const tick = () => {
    const remain = deadlineTs - Date.now() / 1000;
    updatePhaseTimerBar(root, "mp-upload-phase", uploadTotalSec, Math.max(0, remain));
    if (!closedNotified && remain <= 0) {
      closedNotified = true;
      if (statusEl && !statusEl.textContent.includes("Uploaded")) {
        statusEl.textContent = "Timer at 0 — you can still try to upload.";
      }
    }
  };

  if (deadlineTs - Date.now() / 1000 > 0) {
    playSfxUploadAlarm();
  }

  tick();
  tickId = window.setInterval(tick, 250);

  const stopPhasePoll = pollMatchSync(
    String(lobbyId),
    (sync) => {
      if (!httpNavigated && !preserveWs) {
        const L = lobbyLikeFromMatchSync(sync);
        if (L && Array.isArray(L.players) && L.players.length) {
          lobbyView = normalizeLobbyLike(L);
          syncProgressHint();
        }
      }
      if (httpNavigated || preserveWs) return;
      if (String(sync.match_state) !== "voting") return;
      httpNavigated = true;
      preserveWs = true;
      stopPhasePoll();
      const vu = sync.votes_unlock_at;
      const vc = sync.votes_close_at;
      ctx.navigate(mountVotingSlideshowScreen, {
        mpWs: ctx.mpWs,
        playerId,
        lobbyId: ctx.lobbyId,
        beats: Array.isArray(sync.beats) ? sync.beats : [],
        votesUnlockAt: vu,
        votesCloseAt:
          typeof vc === "number" && Number.isFinite(vc)
            ? vc
            : typeof vu === "number" && Number.isFinite(vu)
              ? vu + 30
              : undefined,
      });
    },
    4500,
  );

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = root.querySelector("#beat-file");
    const file = input?.files?.[0];
    if (!file) return;
    playSfxMajor();
    if (statusEl) statusEl.textContent = "Uploading…";
    const fd = new FormData();
    fd.append("player_id", playerId);
    fd.append("file", file);
    try {
      const res = await fetch(`${ctx.apiBase}/upload/beat/${encodeURIComponent(lobbyId)}`, {
        method: "POST",
        headers: authHeadersMultipart(),
        body: fd,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || res.statusText);
      }
      lobbyView = applyMatchWsToLobby(lobbyView, { type: "beat_uploaded", player_id: playerId });
      syncProgressHint();
      if (statusEl) {
        const n = Math.max(1, lobbyView.player_count || lobbyView.players.length);
        const u = lobbyView.uploaded.filter((id) => lobbyView.players.some((p) => p.id === id)).length;
        statusEl.textContent = `Uploaded. Waiting for others (${u}/${n})…`;
      }
    } catch (err) {
      const um = err instanceof Error ? err.message : "Upload failed";
      if (statusEl) statusEl.textContent = um;
      showAppError({ message: `Upload failed: ${um}`, errorCode: "UPLOAD_FETCH" });
    }
  });

  const onMessage = async (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "connected") return;
    if (m.type === "match_resync") {
      await applyMatchResyncFromPayload(ctx, m, "upload");
      return;
    }
    ingestMpChatMessage(m);
    if (m.type === "lobby_dissolved") {
      preserveWs = true;
      void navigateToMenuAfterLobbyDissolved(ctx, ctx.mpWs, m);
      return;
    }
    notifyMpPlayerJoin(m, playerId);
    notifyMpPlayerLeave(m, playerId);
    if (
      m.type === "lobby_update" ||
      m.type === "cook_finished_update" ||
      m.type === "beat_uploaded" ||
      m.type === "vote_cast"
    ) {
      lobbyView = applyMatchWsToLobby(lobbyView, m);
      syncProgressHint();
      if (m.type === "beat_uploaded" && statusEl && statusEl.textContent.includes("Uploaded")) {
        const n = Math.max(1, lobbyView.player_count || lobbyView.players.length);
        const u = lobbyView.uploaded.filter((id) => lobbyView.players.some((p) => p.id === id)).length;
        statusEl.textContent = `Uploaded. Waiting for others (${u}/${n})…`;
      }
    }
    if (m.type === "error") {
      mpChatHandleErrorPayload(m);
      notifyMpServerError(m);
    }
    if (m.type === "voting_start") {
      preserveWs = true;
      const vu = m.votes_unlock_at;
      const vc = m.votes_close_at;
      ctx.navigate(mountVotingSlideshowScreen, {
        mpWs: ctx.mpWs,
        playerId,
        lobbyId: ctx.lobbyId,
        beats: m.beats || [],
        votesUnlockAt: vu,
        votesCloseAt:
          typeof vc === "number" && Number.isFinite(vc)
            ? vc
            : typeof vu === "number" && Number.isFinite(vu)
              ? vu + 30
              : undefined,
      });
    }
  };
  const onUploadSocketClose = (ev) => {
    if (preserveWs || teardownClose) return;
    showServerRestartingWait();
    dismissServerRestartingWait();
    void runMpWsReconnect(ev, {
      ctx,
      intentionalLeave: () => teardownClose,
      preserveWs: () => preserveWs,
      onReplaceSocket: (nw) => {
        ctx.mpWs = nw;
        unmountMpChat();
        unmountMpChat = mountMpChat({
          ws: nw,
          getWs: () => ctx.mpWs,
          playerId,
          continueSession: true,
        });
        nw.onmessage = onMessage;
        nw.addEventListener("close", onUploadSocketClose, { once: true });
      },
    });
  };
  ctx.mpWs.addEventListener("close", onUploadSocketClose, { once: true });
  ctx.mpWs.onmessage = onMessage;

  return () => {
    stopPhasePoll();
    unmountMpChat();
    if (tickId != null) {
      clearInterval(tickId);
      tickId = null;
    }
    teardownClose = true;
    root.innerHTML = "";
    if (!preserveWs) {
      try {
        ctx.mpWs.removeEventListener("close", onUploadSocketClose);
      } catch {
        /* ignore */
      }
      try {
        ctx.mpWs.close();
      } catch {
        /* ignore */
      }
    }
  };
}
