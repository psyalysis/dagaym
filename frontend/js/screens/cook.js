/**
 * CookScreen — shared kit preview, download, 10:00 server timer.
 */
import { authHeaders, fetchMe } from "../authApi.js";
import { RANK_BASELINE_KEY } from "../rankUi.js";
import { getApiBase } from "../apiOrigin.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { playSfxMinor } from "../sfx.js";
import {
  audioBufferToWavBase64,
  fetchKitManifest,
  loadDrumKitBase64Parallel,
  loadSynthAudioBuffersParallel,
  SYNTH_KEYS,
} from "../kitFromSeed.js";
import { runSynthReveal } from "../synthReveal.js";
import { mountUploadScreen } from "./upload.js";

const SOUND_KEYS = [
  "snare",
  "clap",
  "hihat",
  "open_hat",
  "808",
  "perc",
  "fx",
  "vox",
  "synth1",
  "synth2",
  "synth3",
];

function base64ToAudioSrc(b64) {
  return "data:audio/wav;base64," + b64;
}

function getJSZip() {
  const g = globalThis;
  if (g.JSZip) return g.JSZip;
  throw new Error("JSZip not loaded");
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function downloadKitZip(sounds) {
  const JSZip = getJSZip();
  const zip = new JSZip();
  const folder = zip.folder("beat_battle_kit");
  if (!folder) return;
  for (const key of SOUND_KEYS) {
    const b64 = sounds[key];
    if (!b64) continue;
    folder.file(`${key}.wav`, base64ToBytes(b64), { binary: true });
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "beat_battle_kit.zip";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadOneSound(key, b64) {
  if (!b64) return;
  const blob = new Blob([base64ToBytes(b64)], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${key}.wav`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getWaveSurfer() {
  const g = globalThis;
  if (g.WaveSurfer && typeof g.WaveSurfer.create === "function") return g.WaveSurfer;
  throw new Error("WaveSurfer not loaded");
}

function formatTime(totalS) {
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function kitNeedsFetch(sounds) {
  if (!sounds || typeof sounds !== "object") return true;
  return !SOUND_KEYS.every((k) => Boolean(sounds[k]));
}

async function resolveSeedSpice(ctx) {
  let seed = ctx.seed;
  let spice = ctx.spice;
  if (seed != null && spice != null && Number.isFinite(Number(seed)) && Number.isFinite(Number(spice))) {
    return { seed: Number(seed), spice: Number(spice) };
  }
  const res = await fetch(
    `${getApiBase()}/api/lobby/${encodeURIComponent(String(ctx.lobbyId))}/kit`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  const data = await res.json();
  if (data.seed == null || data.spice == null) throw new Error("Invalid kit metadata.");
  return { seed: Number(data.seed), spice: Number(data.spice) };
}

async function buildKitClientSide(root, ctx, start) {
  const { seed, spice } = await resolveSeedSpice(ctx);
  const apiBase = getApiBase();
  const ac = new AudioContext({ sampleRate: 44100 });
  let drumsPending = true;

  root.innerHTML = `
    <div class="screen cook arcade-panel screen--vert-center">
      <p class="arcade-status" id="cook-load">Loading kit…</p>
    </div>`;
  const loadEl = root.querySelector("#cook-load");

  try {
    const manifest = await fetchKitManifest(apiBase);
    const drumPromise = loadDrumKitBase64Parallel({
      seed,
      spice,
      apiBase,
      audioContext: ac,
      manifest,
      onProgress: ({ step, total }) => {
        if (loadEl) loadEl.textContent = `Loading kit ${step} / ${total}…`;
      },
    }).finally(() => {
      drumsPending = false;
    });

    const synthBuffers = await loadSynthAudioBuffersParallel({
      seed,
      spice,
      apiBase,
      audioContext: ac,
      manifest,
    });

    if (loadEl) loadEl.textContent = "";

    await runSynthReveal(root, ac, synthBuffers, () => drumsPending);

    const drumSounds = await drumPromise;
    const sounds = { ...drumSounds };
    for (const k of SYNTH_KEYS) {
      sounds[k] = audioBufferToWavBase64(synthBuffers[k]);
    }
    await ac.close().catch(() => {});
    start(sounds);
  } catch (e) {
    await ac.close().catch(() => {});
    throw e;
  }
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @param {Record<string, string>} sounds
 * @returns {() => void}
 */
function setupCookUI(root, ctx, sounds) {
  const ws = ctx.mpWs;
  const playerId = ctx.playerId;
  const lobbyId = ctx.lobbyId;
  const cookMin = Number(ctx.cookDurationMin) || 10;
  let remaining = cookMin * 60;
  let preserveWs = false;
  let selfFinished = false;

  const waveSurfers = new Map();
  const clickFullPlayback = new Map();

  const destroyWaveSurfers = () => {
    waveSurfers.forEach((wsur) => {
      try {
        wsur.destroy();
      } catch {
        /* ignore */
      }
    });
    waveSurfers.clear();
  };

  mountAuthCornerLeave(ctx);

  root.innerHTML = `
    <div class="screen cook arcade-panel">
      <h2 class="arcade-heading">COOK TIMER</h2>
      <div class="cook-timer" id="cook-timer">00:00</div>
      <p class="arcade-hint">Head to your DAW — kit is below. Download before time ends.</p>
      <div class="cook-actions">
        <button type="button" class="arcade-btn arcade-btn-secondary" id="mp-download-kit">Download kit (ZIP)</button>
        <button type="button" class="arcade-btn arcade-btn-primary" id="mp-finished">Finished</button>
      </div>
      <p class="arcade-hint cook-finished-hint hidden" id="mp-finished-hint" aria-live="polite"></p>
      <div id="mp-sound-grid" class="grid mp-grid" aria-label="Match kit"></div>
    </div>
  `;

  const timerEl = root.querySelector("#cook-timer");
  const grid = root.querySelector("#mp-sound-grid");

  const bindWaveformPlayback = (key, waveWrap, audio) => {
    const setClickFull = (v) => clickFullPlayback.set(key, v);
    audio.addEventListener("ended", () => setClickFull(false));
    waveWrap.addEventListener("click", (e) => {
      e.preventDefault();
      if (!audio.src) return;
      setClickFull(true);
      audio.currentTime = 0;
      audio.play().catch(() => {});
    });
    waveWrap.addEventListener("mouseenter", () => {
      if (!audio.src) return;
      if (clickFullPlayback.get(key)) return;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    });
    waveWrap.addEventListener("mouseleave", () => {
      if (clickFullPlayback.get(key)) return;
      audio.pause();
      audio.currentTime = 0;
    });
  };

  const renderWaveform = (key, dataUrl) => {
    const container = grid?.querySelector(`#mp-wave-${key}`);
    if (!container) return;
    const prev = waveSurfers.get(key);
    if (prev) {
      try {
        prev.destroy();
      } catch {
        /* ignore */
      }
      waveSurfers.delete(key);
    }
    container.innerHTML = "";
    container.classList.remove("empty");
    const WaveSurfer = getWaveSurfer();
    const wsur = WaveSurfer.create({
      container,
      height: 72,
      waveColor: "#b01010",
      progressColor: "#ffffff",
      cursorWidth: 0,
      interact: false,
      url: dataUrl,
    });
    waveSurfers.set(key, wsur);
  };

  SOUND_KEYS.forEach((key) => {
    const card = document.createElement("article");
    card.className = "card";
    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("h2");
    title.className = "card-title";
    title.textContent = key.replace(/_/g, " ");
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "card-download";
    dl.dataset.soundKey = key;
    dl.setAttribute("aria-label", `Download ${key}`);
    dl.textContent = "↓";
    head.append(title, dl);
    const waveWrap = document.createElement("div");
    waveWrap.className = "waveform-wrap empty";
    waveWrap.id = `mp-wave-${key}`;
    waveWrap.textContent = "—";
    const audio = document.createElement("audio");
    audio.id = `mp-audio-${key}`;
    audio.preload = "auto";
    bindWaveformPlayback(key, waveWrap, audio);
    card.append(head, waveWrap, audio);
    grid?.appendChild(card);
  });

  clickFullPlayback.clear();
  SOUND_KEYS.forEach((key) => {
    const b64 = sounds[key];
    if (!b64) return;
    const src = base64ToAudioSrc(b64);
    const audio = grid?.querySelector(`#mp-audio-${key}`);
    if (audio && audio instanceof HTMLAudioElement) audio.src = src;
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      SOUND_KEYS.forEach((key) => {
        const b64 = sounds[key];
        if (!b64) return;
        renderWaveform(key, base64ToAudioSrc(b64));
      });
    });
  });

  const tickTimer = () => {
    if (timerEl) timerEl.textContent = formatTime(remaining);
  };
  tickTimer();

  root.querySelector("#mp-download-kit")?.addEventListener("click", () => {
    playSfxMinor();
    downloadKitZip(sounds).catch(() => {});
  });

  const finishedBtn = root.querySelector("#mp-finished");
  const finishedHint = root.querySelector("#mp-finished-hint");
  const setFinishedUi = () => {
    if (finishedBtn instanceof HTMLButtonElement) {
      finishedBtn.disabled = selfFinished;
      finishedBtn.textContent = selfFinished ? "Done" : "Finished";
    }
  };
  setFinishedUi();

  finishedBtn?.addEventListener("click", () => {
    if (selfFinished) return;
    playSfxMinor();
    selfFinished = true;
    setFinishedUi();
    if (finishedHint) finishedHint.classList.remove("hidden");
    try {
      ws.send(JSON.stringify({ type: "cook_finished" }));
    } catch {
      /* ignore */
    }
  });

  grid?.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".card-download") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    e.preventDefault();
    e.stopPropagation();
    const key = btn.dataset.soundKey;
    if (!key || !sounds[key]) return;
    playSfxMinor();
    downloadOneSound(key, sounds[key]);
  });

  const onMessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "timer_update" && m.phase === "cooking") {
      remaining = m.remaining_s ?? remaining;
      tickTimer();
    }
    if (m.type === "cook_finished_update" && Array.isArray(m.finished_player_ids)) {
      const n = m.finished_player_ids.length;
      const total = Math.max(1, Number(m.player_count) || n);
      if (finishedHint && n > 0) {
        finishedHint.classList.remove("hidden");
        finishedHint.textContent = `${n} / ${total} finished`;
      }
    }
    if (m.type === "upload_phase_start") {
      preserveWs = true;
      destroyWaveSurfers();
      ctx.navigate(mountUploadScreen, {
        mpWs: ws,
        playerId,
        lobbyId,
      });
    }
  };
  ws.onmessage = onMessage;

  return () => {
    destroyWaveSurfers();
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

export function mountCookScreen(root, ctx) {
  const ws = ctx.mpWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
    return () => {};
  }

  void fetchMe()
    .then((me) => sessionStorage.setItem(RANK_BASELINE_KEY, String(me.rank_index ?? 0)))
    .catch(() => {});

  let cancelled = false;
  let innerCleanup = () => {};

  const start = (/** @type {Record<string, string>} */ sounds) => {
    if (cancelled) return;
    innerCleanup = setupCookUI(root, ctx, sounds);
  };

  if (kitNeedsFetch(ctx.sounds)) {
    mountAuthCornerLeave(ctx);
    void (async () => {
      try {
        await buildKitClientSide(root, ctx, start);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          root.innerHTML = `
          <div class="screen cook arcade-panel screen--vert-center">
            <p class="arcade-error">Could not load kit.</p>
            <p class="arcade-hint" id="cook-err-detail"></p>
          </div>`;
          const det = root.querySelector("#cook-err-detail");
          if (det) det.textContent = msg;
        }
      }
    })();
    return () => {
      cancelled = true;
      innerCleanup();
      root.innerHTML = "";
    };
  }

  start(ctx.sounds);
  return () => {
    cancelled = true;
    innerCleanup();
    root.innerHTML = "";
  };
}
