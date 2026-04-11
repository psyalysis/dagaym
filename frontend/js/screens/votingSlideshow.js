/**
 * VotingSlideshowScreen — play up to 30s of each beat; waveform matches audible clip.
 */
import { authHeadersMultipart } from "../authApi.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { mountVoteSelectionScreen } from "./voteSelection.js";

const CLIP_MAX_SEC = 30;

function getWaveSurfer() {
  const g = globalThis;
  if (g.WaveSurfer && typeof g.WaveSurfer.create === "function") return g.WaveSurfer;
  throw new Error("WaveSurfer not loaded");
}

/**
 * First `maxSec` seconds only (same sample rate / channels).
 * @param {AudioContext} ac
 * @param {AudioBuffer} input
 * @param {number} maxSec
 */
function clipAudioBuffer(ac, input, maxSec) {
  const sr = input.sampleRate;
  const maxFrames = Math.min(input.length, Math.floor(maxSec * sr));
  if (maxFrames <= 0) throw new Error("Empty audio.");
  const out = ac.createBuffer(input.numberOfChannels, maxFrames, sr);
  for (let c = 0; c < input.numberOfChannels; c++) {
    out.copyToChannel(input.getChannelData(c).subarray(0, maxFrames), c);
  }
  return out;
}

/** 16-bit PCM WAV for WaveSurfer + `<audio>`. */
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([wav], { type: "audio/wav" });
}

/**
 * Decode fetched audio, clip to CLIP_MAX_SEC, return WAV blob for URL.
 * @param {Blob} blob
 */
async function blobToClippedWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ac = new AudioContext();
  try {
    const decoded = await ac.decodeAudioData(arrayBuffer.slice(0));
    const clipped = clipAudioBuffer(ac, decoded, CLIP_MAX_SEC);
    return audioBufferToWav(clipped);
  } finally {
    await ac.close().catch(() => {});
  }
}

export function mountVotingSlideshowScreen(root, ctx) {
  mountAuthCornerLeave(ctx);

  const wsSock = ctx.mpWs;
  const playerId = ctx.playerId;
  const beats = ctx.beats || [];
  const votesUnlockAt = ctx.votesUnlockAt;
  let preserveWs = false;
  let activeWsur = null;
  let idx = 0;
  /** @type {string | null} */
  let slideObjectUrl = null;

  root.innerHTML = `
    <div class="screen slideshow arcade-panel">
      <h2 class="arcade-heading" id="slide-title">VOTING</h2>
      <p class="slide-player" id="slide-player"></p>
      <div id="slide-wave" class="slideshow-wave"></div>
      <p class="arcade-hint" id="slide-progress"></p>
    </div>
  `;

  const titleEl = root.querySelector("#slide-title");
  const nameEl = root.querySelector("#slide-player");
  const waveEl = root.querySelector("#slide-wave");
  const progEl = root.querySelector("#slide-progress");

  const goVote = () => {
    preserveWs = true;
    if (activeWsur) {
      try {
        activeWsur.destroy();
      } catch {
        /* ignore */
      }
      activeWsur = null;
    }
    try {
      wsSock.send(JSON.stringify({ type: "slideshow_complete" }));
    } catch {
      /* ignore */
    }
    const nowSec = Date.now() / 1000;
    ctx.navigate(mountVoteSelectionScreen, {
      mpWs: wsSock,
      playerId,
      lobbyId: ctx.lobbyId,
      beats,
      votesUnlockAt: Math.min(votesUnlockAt ?? nowSec, nowSec),
    });
  };

  const playNext = async () => {
    if (idx >= beats.length) {
      goVote();
      return;
    }
    const b = beats[idx];
    if (nameEl) nameEl.textContent = `${b.name} — Beat`;
    if (titleEl) titleEl.textContent = "NOW PLAYING";
    if (progEl) progEl.textContent = `${idx + 1} / ${beats.length}`;
    if (waveEl) waveEl.innerHTML = "";

    const fullUrl = `${ctx.apiBase}${b.url}?requester=${encodeURIComponent(playerId)}`;

    let wsur = null;

    /** @type {ReturnType<typeof setInterval> | null} */
    let poll = null;
    /** @type {(() => void) | null} */
    let removeTimeCap = null;
    let slideClosed = false;

    const teardownSlide = () => {
      if (poll != null) {
        clearInterval(poll);
        poll = null;
      }
      if (removeTimeCap) {
        try {
          removeTimeCap();
        } catch {
          /* ignore */
        }
        removeTimeCap = null;
      }
      try {
        wsur?.destroy();
      } catch {
        /* ignore */
      }
      if (slideObjectUrl) {
        URL.revokeObjectURL(slideObjectUrl);
        slideObjectUrl = null;
      }
      if (activeWsur === wsur) activeWsur = null;
      wsur = null;
    };

    const advance = () => {
      if (slideClosed) return;
      slideClosed = true;
      teardownSlide();
      idx += 1;
      void playNext();
    };

    try {
      const res = await fetch(fullUrl, { headers: authHeadersMultipart() });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();

      let clipped = true;
      let playBlob = blob;
      try {
        playBlob = await blobToClippedWav(blob);
      } catch {
        clipped = false;
      }

      slideObjectUrl = URL.createObjectURL(playBlob);
      const WaveSurfer = getWaveSurfer();
      wsur = WaveSurfer.create({
        container: waveEl,
        height: 120,
        waveColor: "#b01010",
        progressColor: "#ffffff",
        cursorWidth: 2,
        url: slideObjectUrl,
      });
      activeWsur = wsur;

      wsur.on("finish", () => {
        advance();
      });

      wsur.on("ready", () => {
        if (!wsur || slideClosed) return;
        wsur.play();

        if (!clipped) {
          const dur =
            typeof wsur.getDuration === "function" ? wsur.getDuration() : Number.NaN;
          const end = Math.min(CLIP_MAX_SEC, Number.isFinite(dur) ? dur : CLIP_MAX_SEC);
          const media = wsur.getMediaElement?.();
          const cap = () => {
            if (slideClosed || !wsur) return;
            const t =
              typeof wsur.getCurrentTime === "function"
                ? wsur.getCurrentTime()
                : media?.currentTime ?? 0;
            if (t >= end - 0.05) {
              advance();
            }
          };
          poll = window.setInterval(cap, 50);
          if (media) {
            const onTime = () => cap();
            media.addEventListener("timeupdate", onTime);
            removeTimeCap = () => media.removeEventListener("timeupdate", onTime);
          }
        }
      });

      wsur.on("error", () => {
        advance();
      });
    } catch {
      teardownSlide();
      idx += 1;
      void playNext();
    }
  };

  const onSocket = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "results") {
      preserveWs = true;
      import("./results.js").then((mod) => {
        ctx.navigate(mod.mountResultsScreen, {
          mpWs: wsSock,
          results: m,
        });
      });
    }
  };
  wsSock.onmessage = onSocket;

  if (beats.length === 0) {
    goVote();
  } else {
    void playNext();
  }

  return () => {
    if (slideObjectUrl) {
      URL.revokeObjectURL(slideObjectUrl);
      slideObjectUrl = null;
    }
    if (activeWsur) {
      try {
        activeWsur.destroy();
      } catch {
        /* ignore */
      }
    }
    root.innerHTML = "";
    if (!preserveWs) {
      try {
        wsSock.close();
      } catch {
        /* ignore */
      }
    }
  };
}
