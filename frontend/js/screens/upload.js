/**
 * Upload phase: pick a beat, hit the server before the timer ghosts you.
 */
import { authHeaders, authHeadersMultipart } from "../authApi.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import {
  notifyMpServerError,
  setAppErrorContext,
  showAppError,
} from "../errorToast.js";
import {
  dismissServerRestartingWait,
  showServerRestartingWait,
} from "../serverRestartOverlay.js";
import { applyMatchResyncFromPayload } from "../mpMatchResync.js";
import { runMpWsReconnect } from "../mpReconnect.js";
import { saveMpSeat } from "../mpSeatStorage.js";
import {
  navigateToMenuAfterLobbyDissolved,
  notifyMpPlayerDisconnected,
  notifyMpPlayerJoin,
  notifyMpPlayerLeave,
} from "../mpPresenceToast.js";
import {
  ingestMpChatMessage,
  mountMpChat,
  mpChatHandleErrorPayload,
} from "../mpChat.js";
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
const MAX_BEAT_BYTES = 30 * 1024 * 1024;

const BEAT_FILE_RE = /\.(mp3|ogg)$/i;
const UNSUPPORTED_BEAT_TYPE =
  "Only MP3 or OGG files are supported for your beat.";

/**
 * @param {File} file
 * @returns {boolean}
 */
function isSupportedBeatFile(file) {
  const n = (file.name || "").trim();
  if (BEAT_FILE_RE.test(n)) return true;
  const t = (file.type || "").trim().toLowerCase();
  if (t === "audio/mpeg" || t === "audio/ogg" || t === "application/ogg")
    return true;
  return false;
}

/**
 * @param {File} file
 * @returns {string}
 */
function beatContentTypeForR2(file) {
  const n = (file.name || "").toLowerCase();
  if (n.endsWith(".ogg")) {
    const t = (file.type || "").trim().toLowerCase();
    if (t === "application/ogg" || t === "audio/ogg") return "audio/ogg";
    return "audio/ogg";
  }
  if (n.endsWith(".mp3")) {
    const t = (file.type || "").trim().toLowerCase();
    if (t === "audio/mpeg" || t === "audio/mp3") return "audio/mpeg";
    return "audio/mpeg";
  }
  throw new Error(UNSUPPORTED_BEAT_TYPE);
}

/**
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function uploadErrorMessage(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    try {
      const txt = await res.text();
      if (txt) return txt;
    } catch {
      /* ignore */
    }
    return res.statusText || "Upload failed";
  }
  const detail = data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail[0]) {
    const msg = String(detail[0]?.msg || "").trim();
    if (msg.includes("content_type must be")) {
      return UNSUPPORTED_BEAT_TYPE;
    }
    if (msg) return msg;
  }
  return res.statusText || "Upload failed";
}

export function mountUploadScreen(root, ctx) {
  setAppErrorContext({
    screen: "Upload",
    phase: "Upload beat before time runs out",
  });
  if (!ctx.mpWs || ctx.mpWs.readyState !== WebSocket.OPEN) {
    import("./multiplayerHub.js").then((m) =>
      ctx.navigate(m.mountMultiplayerHubScreen),
    );
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
  /** @type {boolean | null} */
  let useR2Direct = null;

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
      <p class="arcade-hint">MP3 or OGG · max 30MB · up to 45s</p>
      <p class="arcade-hint upload-hint-muted">No upload? You can still listen and vote!</p>
      <p class="arcade-hint upload-hint-muted hidden" id="upload-on-server">Already uploaded</p>
      <form id="upload-form" class="upload-form">
        <input type="file" id="beat-file" accept=".mp3,.ogg,audio/mpeg,audio/ogg" required />
        <button type="submit" class="arcade-btn arcade-btn-primary" id="upload-submit">Upload</button>
      </form>
      <p class="arcade-status" id="upload-status"></p>
    </div>
  `;

  const form = root.querySelector("#upload-form");
  const statusEl = root.querySelector("#upload-status");
  const uploadHintEl = root.querySelector(".screen.upload > .arcade-hint");
  if (uploadHintEl)
    uploadHintEl.textContent = "MP3 or OGG — max 30MB — up to 45s";
  const uploadTotalSec = UPLOAD_WINDOW_SEC;

  /** @type {ReturnType<typeof normalizeLobbyLike>} */
  let lobbyView = normalizeLobbyLike({});
  const syncProgressHint = () =>
    syncMatchProgressHint(root, "mp-corner-upload", "upload", lobbyView);

  const selfUploaded = () =>
    lobbyView.uploaded.some((id) => String(id) === String(playerId));

  const syncSelfUploadUi = () => {
    const formEl = root.querySelector("#upload-form");
    const fileIn = root.querySelector("#beat-file");
    const submitBtn = root.querySelector("#upload-submit");
    const onServer = root.querySelector("#upload-on-server");
    if (!selfUploaded()) {
      formEl?.classList.remove("upload-form--on-server");
      if (onServer instanceof HTMLElement) onServer.classList.add("hidden");
      if (fileIn instanceof HTMLInputElement) fileIn.required = true;
      if (submitBtn instanceof HTMLButtonElement)
        submitBtn.textContent = "Upload";
      return;
    }
    formEl?.classList.add("upload-form--on-server");
    if (onServer instanceof HTMLElement) onServer.classList.remove("hidden");
    if (fileIn instanceof HTMLInputElement) fileIn.required = false;
    if (statusEl) {
      const n = Math.max(1, lobbyView.player_count || lobbyView.players.length);
      const u = lobbyView.uploaded.filter((id) =>
        lobbyView.players.some((p) => String(p.id) === String(id)),
      ).length;
      statusEl.textContent = `Uploaded. Waiting for others (${u}/${n})…`;
    }
    if (submitBtn instanceof HTMLButtonElement) {
      submitBtn.textContent = "Replace beat";
    }
  };

  void (async () => {
    try {
      const capRes = await fetch(`${ctx.apiBase}/api/upload/capabilities`);
      if (capRes.ok) {
        const cap = await capRes.json();
        useR2Direct = Boolean(cap.r2_direct);
      } else {
        useR2Direct = false;
      }
    } catch {
      useR2Direct = false;
    }
    const sync = await fetchMatchSync(String(lobbyId));
    const L = lobbyLikeFromMatchSync(sync);
    if (L) {
      lobbyView = normalizeLobbyLike(L);
      syncProgressHint();
      syncSelfUploadUi();
    }
  })();

  const tick = () => {
    const remain = deadlineTs - Date.now() / 1000;
    updatePhaseTimerBar(
      root,
      "mp-upload-phase",
      uploadTotalSec,
      Math.max(0, remain),
    );
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
        if (L) {
          lobbyView = normalizeLobbyLike(L);
          syncProgressHint();
          syncSelfUploadUi();
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
    () => ctx.mpWs?.readyState !== WebSocket.OPEN,
  );

  const beatFileInput = root.querySelector("#beat-file");
  if (beatFileInput instanceof HTMLInputElement) {
    beatFileInput.addEventListener("change", () => {
      const f = beatFileInput.files?.[0];
      if (!f || isSupportedBeatFile(f)) return;
      beatFileInput.value = "";
      if (statusEl) statusEl.textContent = "";
      showAppError({
        message: UNSUPPORTED_BEAT_TYPE,
        hint: "Choose a file ending in .mp3 or .ogg.",
        errorCode: "UPLOAD_BAD_TYPE",
      });
    });
  }

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = root.querySelector("#beat-file");
    const file = input?.files?.[0];
    if (!file) return;
    if (!isSupportedBeatFile(file)) {
      showAppError({
        message: UNSUPPORTED_BEAT_TYPE,
        hint: "Choose a file ending in .mp3 or .ogg.",
        errorCode: "UPLOAD_BAD_TYPE",
      });
      return;
    }
    if (file.size > MAX_BEAT_BYTES) {
      const um = "File too large (max 30MB).";
      if (statusEl) statusEl.textContent = um;
      showAppError({
        message: um,
        hint: "Pick a smaller file.",
        errorCode: "UPLOAD_TOO_LARGE",
      });
      return;
    }
    playSfxMajor();
    if (statusEl) statusEl.textContent = "Uploading…";
    const tryR2 = useR2Direct === true;
    try {
      if (tryR2) {
        const ct = beatContentTypeForR2(file);
        const pres = await fetch(`${ctx.apiBase}/api/upload/presign`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            lobby_id: lobbyId,
            player_id: playerId,
            content_type: ct,
          }),
        });
        if (pres.status === 503) {
          useR2Direct = false;
          throw new Error("R2 not configured — refresh and try again.");
        }
        if (!pres.ok) {
          throw new Error(await uploadErrorMessage(pres));
        }
        /** @type {{ upload_id: string, put_url: string, required_headers: Record<string, string> }} */
        const presBody = await pres.json();
        const putRes = await fetch(presBody.put_url, {
          method: "PUT",
          body: file,
          headers: presBody.required_headers,
        });
        if (!putRes.ok) {
          const t = await putRes.text();
          throw new Error(t || `R2 PUT ${putRes.status}`);
        }
        const etagRaw =
          putRes.headers.get("ETag") || putRes.headers.get("etag") || "";
        const comp = await fetch(`${ctx.apiBase}/api/upload/complete`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            lobby_id: lobbyId,
            player_id: playerId,
            upload_id: presBody.upload_id,
            content_length: file.size,
            etag: etagRaw,
          }),
        });
        if (!comp.ok) {
          throw new Error(await uploadErrorMessage(comp));
        }
      } else {
        const fd = new FormData();
        fd.append("player_id", playerId);
        fd.append("file", file);
        const res = await fetch(
          `${ctx.apiBase}/upload/beat/${encodeURIComponent(lobbyId)}`,
          {
            method: "POST",
            headers: authHeadersMultipart(),
            body: fd,
          },
        );
        if (!res.ok) {
          throw new Error(await uploadErrorMessage(res));
        }
      }
      lobbyView = applyMatchWsToLobby(lobbyView, {
        type: "beat_uploaded",
        player_id: playerId,
      });
      syncProgressHint();
      syncSelfUploadUi();
    } catch (err) {
      const um = err instanceof Error ? err.message : "Upload failed";
      const badType =
        um.includes(UNSUPPORTED_BEAT_TYPE) ||
        um.includes("Only .mp3") ||
        um.includes(".mp3 or .ogg") ||
        um.includes("content_type must be");
      if (statusEl) statusEl.textContent = badType ? UNSUPPORTED_BEAT_TYPE : um;
      showAppError({
        message: badType ? UNSUPPORTED_BEAT_TYPE : `Upload failed: ${um}`,
        hint: badType
          ? "Choose a file ending in .mp3 or .ogg."
          : "Check your connection and file size, then try again.",
        errorCode: "UPLOAD_FETCH",
      });
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
    notifyMpPlayerDisconnected(m, playerId);
    if (
      m.type === "lobby_update" ||
      m.type === "cook_finished_update" ||
      m.type === "beat_uploaded" ||
      m.type === "vote_cast"
    ) {
      lobbyView = applyMatchWsToLobby(lobbyView, m);
      syncProgressHint();
      syncSelfUploadUi();
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
