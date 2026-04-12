/**
 * VotingSlideshowScreen — play up to 45s of each beat; waveform matches audible clip.
 */
import { authHeadersMultipart } from "../authApi.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { notifyMpServerError } from "../errorToast.js";
import { showServerRestartingWait } from "../serverRestartOverlay.js";
import {
  navigateToMenuAfterLobbyDissolved,
  notifyMpPlayerJoin,
  notifyMpPlayerLeave,
} from "../mpPresenceToast.js";
import { ingestMpChatMessage, mountMpChat, mpChatHandleErrorPayload } from "../mpChat.js";
import { playSfxMinor } from "../sfx.js";
import { mountVoteSelectionScreen } from "./voteSelection.js";

/** @type {Record<string, string>} */
const BEAT_REACTION_EMOJI = {
  fire: "🔥",
  thumbs_up: "👍",
  thumbs_down: "👎",
  hundred: "💯",
};

const BEAT_REACTION_KEYS = Object.keys(BEAT_REACTION_EMOJI);

/** @type {Record<string, string>} */
const BEAT_REACTION_ARIA = {
  fire: "Fire",
  thumbs_up: "Thumbs up",
  thumbs_down: "Thumbs down",
  hundred: "One hundred",
};

const CLIP_MAX_SEC = 45;

/** Min ms between beat reaction sends (client-side; reduces spam). */
const BEAT_REACTION_COOLDOWN_MS = 3000;

const BEAT_TOAST_VISIBLE_MS = 1000;
const BEAT_TOAST_FADE_MS = 200;
const BEAT_TOAST_HOST_ID = "beat-reaction-toast-host";

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
  /** True while unmount closes the socket on purpose (avoid restart overlay). */
  let teardownClose = false;
  let activeWsur = null;
  let idx = 0;
  /** @type {string | null} */
  let slideObjectUrl = null;
  /** @type {string | null} */
  let currentBeatOwnerId = null;

  const unmountMpChat =
    wsSock instanceof WebSocket ? mountMpChat({ ws: wsSock, playerId }) : () => {};

  root.innerHTML = `
    <div class="screen slideshow arcade-panel">
      <h2 class="arcade-heading" id="slide-title">VOTING</h2>
      <p class="slide-player" id="slide-player"></p>
      <div id="slide-wave" class="slideshow-wave"></div>
      <div class="slideshow-reactions" id="slideshow-reactions" hidden>
        <div class="slideshow-reaction-btns" role="group" aria-label="Beat reactions">
          ${BEAT_REACTION_KEYS.map(
            (k) =>
              `<button type="button" class="slideshow-reaction-btn" data-beat-reaction="${k}" aria-label="${BEAT_REACTION_ARIA[k] || k}">${BEAT_REACTION_EMOJI[k]}</button>`,
          ).join("")}
        </div>
      </div>
      <p class="arcade-hint" id="slide-progress"></p>
    </div>
  `;

  const titleEl = root.querySelector("#slide-title");
  const nameEl = root.querySelector("#slide-player");
  const waveEl = root.querySelector("#slide-wave");
  const progEl = root.querySelector("#slide-progress");
  const reactionsEl = root.querySelector("#slideshow-reactions");

  /** @type {number} */
  let beatReactionCooldownUntil = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let beatReactionCooldownTimer = null;

  /** @param {boolean} on */
  const setBeatReactionButtonsCooldown = (on) => {
    const wrap = root.querySelector(".slideshow-reaction-btns");
    if (!wrap) return;
    wrap.classList.toggle("slideshow-reaction-btns--cooldown", on);
    wrap.querySelectorAll("button").forEach((b) => {
      if (b instanceof HTMLButtonElement) b.disabled = on;
    });
  };

  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const beatToastTimeouts = new Set();

  const clearBeatToastTimers = () => {
    beatToastTimeouts.forEach((id) => clearTimeout(id));
    beatToastTimeouts.clear();
  };

  const removeBeatToastHost = () => {
    document.getElementById(BEAT_TOAST_HOST_ID)?.remove();
  };

  /**
   * @param {string} fromName
   * @param {string} reactionKey
   */
  const showBeatReactionToast = (fromName, reactionKey) => {
    const ch = BEAT_REACTION_EMOJI[reactionKey] || "·";
    let host = document.getElementById(BEAT_TOAST_HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = BEAT_TOAST_HOST_ID;
      host.className = "lobby-wave-toast-host";
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }

    const card = document.createElement("div");
    card.className = "lobby-wave-toast";
    card.setAttribute("role", "status");
    const toastName = document.createElement("span");
    toastName.className = "lobby-wave-toast-name";
    toastName.textContent = fromName;
    const emojiEl = document.createElement("span");
    emojiEl.className = "lobby-wave-toast-emoji";
    emojiEl.setAttribute("aria-hidden", "true");
    emojiEl.textContent = ch;
    card.append(toastName, emojiEl);
    host.appendChild(card);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => card.classList.add("lobby-wave-toast--visible"));
    });

    const hide = window.setTimeout(() => {
      beatToastTimeouts.delete(hide);
      card.classList.remove("lobby-wave-toast--visible");
      const remove = window.setTimeout(() => {
        beatToastTimeouts.delete(remove);
        card.remove();
        if (host && host.childElementCount === 0) removeBeatToastHost();
      }, BEAT_TOAST_FADE_MS);
      beatToastTimeouts.add(remove);
    }, BEAT_TOAST_VISIBLE_MS);
    beatToastTimeouts.add(hide);
  };

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
    currentBeatOwnerId = b.player_id || null;
    clearBeatToastTimers();
    removeBeatToastHost();
    const listeningOthers = b.player_id && b.player_id !== playerId;
    if (reactionsEl) {
      reactionsEl.hidden = !listeningOthers;
    }
    if (nameEl) nameEl.textContent = String(b.name ?? "");
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

  const appendReactionLine = (fromName, reactionKey) => {
    if (!currentBeatOwnerId) return;
    showBeatReactionToast(fromName, reactionKey);
  };

  const reactionClick = (e) => {
    const origin = e.target instanceof Element ? e.target : null;
    const btn = origin?.closest?.("[data-beat-reaction]");
    if (!(btn instanceof HTMLButtonElement) || !reactionsEl || reactionsEl.hidden) return;
    if (Date.now() < beatReactionCooldownUntil) return;
    const target = currentBeatOwnerId;
    const reaction = btn.dataset.beatReaction;
    if (!target || !reaction) return;
    playSfxMinor();
    try {
      wsSock.send(
        JSON.stringify({
          type: "beat_reaction",
          target_player_id: target,
          reaction,
        }),
      );
      beatReactionCooldownUntil = Date.now() + BEAT_REACTION_COOLDOWN_MS;
      setBeatReactionButtonsCooldown(true);
      if (beatReactionCooldownTimer != null) clearTimeout(beatReactionCooldownTimer);
      beatReactionCooldownTimer = setTimeout(() => {
        beatReactionCooldownTimer = null;
        beatReactionCooldownUntil = 0;
        setBeatReactionButtonsCooldown(false);
      }, BEAT_REACTION_COOLDOWN_MS);
    } catch {
      /* ignore */
    }
  };
  reactionsEl?.addEventListener("click", reactionClick);

  const onSocket = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    ingestMpChatMessage(m);
    if (m.type === "lobby_dissolved") {
      preserveWs = true;
      void navigateToMenuAfterLobbyDissolved(ctx, wsSock, m);
      return;
    }
    notifyMpPlayerJoin(m, playerId);
    notifyMpPlayerLeave(m, playerId);
    if (m.type === "error") {
      mpChatHandleErrorPayload(m);
      notifyMpServerError(m);
    }
    if (m.type === "beat_reaction" && m.from_name && m.reaction && m.target_player_id) {
      if (m.target_player_id === currentBeatOwnerId) {
        appendReactionLine(String(m.from_name), String(m.reaction));
      }
    }
    if (m.type === "results") {
      preserveWs = true;
      import("./results.js").then((mod) => {
        ctx.navigate(mod.mountResultsScreen, {
          mpWs: wsSock,
          results: m,
          playerId,
        });
      });
    }
  };
  wsSock.onclose = () => {
    if (preserveWs || teardownClose) return;
    showServerRestartingWait();
  };
  wsSock.onmessage = onSocket;

  if (beats.length === 0) {
    goVote();
  } else {
    void playNext();
  }

  return () => {
    unmountMpChat();
    if (beatReactionCooldownTimer != null) clearTimeout(beatReactionCooldownTimer);
    clearBeatToastTimers();
    removeBeatToastHost();
    reactionsEl?.removeEventListener("click", reactionClick);
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
    teardownClose = true;
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
