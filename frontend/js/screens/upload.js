/**
 * UploadScreen — mp3/wav upload during upload phase.
 */
import { authHeadersMultipart } from "../authApi.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { playSfxMajor, playSfxUploadAlarm, playSfxUploadWarning30 } from "../sfx.js";
import { mountVotingSlideshowScreen } from "./votingSlideshow.js";

export function mountUploadScreen(root, ctx) {
  const ws = ctx.mpWs;
  const playerId = ctx.playerId;
  const lobbyId = ctx.lobbyId;
  const rawDeadline = ctx.uploadDeadlineTs;
  const deadlineTs =
    typeof rawDeadline === "number" && Number.isFinite(rawDeadline)
      ? rawDeadline
      : Date.now() / 1000 + 60;
  let preserveWs = false;
  let warningPlayed = false;
  let alarmPlayed = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let tickId = null;

  mountAuthCornerLeave(ctx);

  root.innerHTML = `
    <div class="screen upload arcade-panel">
      <h2 class="arcade-heading">UPLOAD BEAT</h2>
      <p class="upload-timer" id="upload-timer" aria-live="polite">1:00</p>
      <p class="arcade-hint">1 minute · MP3 or WAV · max 15MB</p>
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
  const timerEl = root.querySelector("#upload-timer");
  const fileInput = root.querySelector("#beat-file");
  const submitBtn = root.querySelector("#upload-submit");

  const setUploadEnabled = (on) => {
    if (fileInput instanceof HTMLInputElement) fileInput.disabled = !on;
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = !on;
  };

  const formatRemain = (sec) => {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  const tick = () => {
    const remain = deadlineTs - Date.now() / 1000;
    if (timerEl) timerEl.textContent = formatRemain(remain);
    if (!warningPlayed && remain > 0 && remain <= 30) {
      warningPlayed = true;
      playSfxUploadWarning30();
    }
    if (!alarmPlayed && remain <= 0) {
      alarmPlayed = true;
      playSfxUploadAlarm();
      setUploadEnabled(false);
      if (statusEl && !statusEl.textContent.includes("Uploaded")) {
        statusEl.textContent = "Upload window closed.";
      }
    }
  };

  tick();
  tickId = window.setInterval(tick, 250);

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (deadlineTs - Date.now() / 1000 <= 0) return;
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
      if (statusEl) statusEl.textContent = "Uploaded. Waiting for others…";
    } catch (err) {
      if (statusEl)
        statusEl.textContent = err instanceof Error ? err.message : "Upload failed";
    }
  });

  const onMessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "voting_start") {
      preserveWs = true;
      ctx.navigate(mountVotingSlideshowScreen, {
        mpWs: ws,
        playerId,
        lobbyId: ctx.lobbyId,
        beats: m.beats || [],
        votesUnlockAt: m.votes_unlock_at,
      });
    }
  };
  ws.onmessage = onMessage;

  return () => {
    if (tickId != null) {
      clearInterval(tickId);
      tickId = null;
    }
    root.innerHTML = "";
    if (!preserveWs) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}
