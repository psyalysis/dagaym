/**
 * Solo mode: same light-kit path as MP — manifest + pulls from /media/dataset.
 */
import { mountAuthCornerLeave } from "./authCorner.js";
import { getApiBase } from "./apiOrigin.js";
import { setAppErrorContext } from "./errorToast.js";
import {
  fetchKitManifest,
  getKitSoundKeys,
  getSynthKeys,
  KIT_SOUND_FILE_EXT,
  loadDrumKitBase64Parallel,
  loadSynthBuffersAndMp3Base64Parallel,
  normalizeKitGenre,
} from "./kitFromSeed.js";
import { kitSlotDisplayLabel, mountKitLayoutShell } from "./kitGridLayout.js";
import { transitionPanelHeight } from "./panelHeightTransition.js";
import { playSfxMajor, playSfxMinor, playSfxOn } from "./sfx.js";
import { runSynthReveal } from "./synthReveal.js";

const CHILI_SRC = new URL("../../imgs/chili.png", import.meta.url).href;

const SPICES = [
  { value: 0.25, count: 1 },
  { value: 0.5, count: 2 },
  { value: 0.85, count: 3 },
];

/** EDM kits hide spice UI; RNG still needs a value — fixed canonical heat. */
const EDM_FIXED_SPICE = 0.5;

function base64ToAudioSrc(base64) {
  return "data:audio/ogg;base64," + base64;
}

function getWaveSurfer() {
  const g = globalThis;
  if (g.WaveSurfer && typeof g.WaveSurfer.create === "function")
    return g.WaveSurfer;
  throw new Error("WaveSurfer not loaded");
}

function getJSZip() {
  const g = globalThis;
  if (g.JSZip) return g.JSZip;
  throw new Error("JSZip not loaded");
}

function resolveApiBase(ctx) {
  const b = ctx.apiBase;
  if (typeof b === "string" && b.trim().length > 0) {
    return b.trim().replace(/\/$/, "");
  }
  return getApiBase();
}

export function mountSoloScreen(root, ctx) {
  setAppErrorContext({ screen: "Solo mode", phase: "Offline kit" });
  const apiBase = resolveApiBase(ctx);
  /** @type {"trap" | "edm"} */
  let kitGenre = normalizeKitGenre(ctx.kitGenre);
  const waveSurfers = new Map();
  const audioSrcByKey = new Map();
  const clickFullPlayback = new Map();
  let lastSoundsB64 = null;
  /** @type {number | null} */
  let lastKitSeed = null;
  /** @type {number | null} */
  let lastKitSpice = null;
  /** Solo: one discrete spice level (same values as multiplayer heat cards). */
  let selectedSpice = 0.5;
  /** @type {HTMLElement | null} */
  let activeKitOverlay = null;
  /** @type {AudioContext | null} */
  let activeKitAc = null;

  const clearKitLoadUi = () => {
    if (activeKitOverlay) {
      activeKitOverlay.remove();
      activeKitOverlay = null;
    }
    if (activeKitAc) {
      void activeKitAc.close().catch(() => {});
      activeKitAc = null;
    }
  };

  const destroyWaveSurfers = () => {
    waveSurfers.forEach((ws) => {
      try {
        ws.destroy();
      } catch {
        /* ignore */
      }
    });
    waveSurfers.clear();
  };

  mountAuthCornerLeave(ctx);

  root.innerHTML = `
    <div class="screen solo arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="solo-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">SOLO MODE</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <section class="toolbar solo-toolbar" aria-label="Controls">
        <div class="mp-hub-body solo-toolbar-stack">
          <fieldset class="visibility-field">
            <legend class="arcade-label">Genre</legend>
            <label class="vis-option"><input type="radio" name="solo-genre" value="trap" ${
              kitGenre === "edm" ? "" : "checked"
            } /> Trap</label>
            <label class="vis-option"><input type="radio" name="solo-genre" value="edm" ${
              kitGenre === "edm" ? "checked" : ""
            } /> EDM</label>
          </fieldset>
          <fieldset
            class="visibility-field"
            id="solo-spice-fieldset"
            ${kitGenre === "edm" ? "hidden" : ""}
          >
            <legend class="arcade-label">Spiciness</legend>
            <div class="spice-cards" id="solo-spice-cards" role="radiogroup" aria-label="Spiciness"></div>
          </fieldset>
          <div class="toolbar-actions">
            <button type="button" id="btn-generate" class="arcade-btn arcade-btn-primary">Generate Battle Kit</button>
            <div id="kit-actions" class="kit-actions hidden">
              <button type="button" id="btn-regenerate" class="arcade-btn arcade-btn-primary">ReGenerate Battle Kit</button>
              <button type="button" id="btn-download-all" class="arcade-btn arcade-btn-secondary">Download all</button>
            </div>
          </div>
        </div>
      </section>
      <p id="status" class="status arcade-status" aria-live="polite"></p>
      <main id="sound-grid" class="kit-layout mp-grid hidden" aria-label="Generated kit"></main>
    </div>
  `;

  const soloSpiceCardsEl = root.querySelector("#solo-spice-cards");
  const refreshSoloSpiceCards = () => {
    soloSpiceCardsEl?.querySelectorAll(".spice-card").forEach((btn) => {
      if (!(btn instanceof HTMLButtonElement)) return;
      const v = parseFloat(btn.dataset.spice || "0");
      const active = v === selectedSpice;
      btn.classList.toggle("spice-card--active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
  };
  SPICES.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "spice-card";
    b.dataset.spice = String(s.value);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    const row = document.createElement("span");
    row.className = "spice-card-chilis";
    row.setAttribute("aria-hidden", "true");
    for (let i = 0; i < s.count; i++) {
      const img = document.createElement("img");
      img.className = "spice-chili-icon";
      img.src = CHILI_SRC;
      img.alt = "";
      img.width = 32;
      img.height = 32;
      row.appendChild(img);
    }
    b.appendChild(row);
    b.addEventListener("click", () => {
      if (selectedSpice === s.value) return;
      playSfxOn();
      selectedSpice = s.value;
      refreshSoloSpiceCards();
    });
    soloSpiceCardsEl?.appendChild(b);
  });
  refreshSoloSpiceCards();

  const soloSpiceFieldset = root.querySelector("#solo-spice-fieldset");
  const soloPanel = root.querySelector(".screen.solo.arcade-panel");
  const syncSoloSpiceFieldVisibility = (animated = false) => {
    const g = normalizeKitGenre(kitGenre);
    const shouldHide = g === "edm";
    const apply = () => {
      if (soloSpiceFieldset instanceof HTMLFieldSetElement) {
        soloSpiceFieldset.hidden = shouldHide;
      }
    };
    if (
      animated &&
      soloPanel instanceof HTMLElement &&
      soloSpiceFieldset instanceof HTMLFieldSetElement
    ) {
      transitionPanelHeight(soloPanel, apply);
    } else {
      apply();
    }
  };
  syncSoloSpiceFieldVisibility(false);

  root.querySelectorAll('input[name="solo-genre"]').forEach((input) => {
    input.addEventListener("change", () => {
      playSfxOn();
      kitGenre = normalizeKitGenre(
        root.querySelector('input[name="solo-genre"]:checked')?.getAttribute(
          "value",
        ),
      );
      ctx.kitGenre = kitGenre;
      syncSoloSpiceFieldVisibility(true);
      if (lastSoundsB64) {
        lastSoundsB64 = null;
        lastKitSeed = null;
        lastKitSpice = null;
        destroyWaveSurfers();
        audioSrcByKey.clear();
        clickFullPlayback.clear();
        setKitUiVisible(false);
        const st = root.querySelector("#status");
        if (st) st.textContent = "Genre changed — generate a new kit.";
      }
    });
  });

  root.querySelector("#solo-back")?.addEventListener("click", async () => {
    playSfxMinor();
    clearKitLoadUi();
    destroyWaveSurfers();
    const m = await import("./screens/modeSelect.js");
    ctx.navigate(m.mountModeSelectScreen);
  });

  function buildKitCard(key) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.sound = key;

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("h2");
    title.className = "card-title";
    title.textContent = kitSlotDisplayLabel(key, kitGenre);
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "card-download";
    dl.dataset.soundKey = key;
    dl.setAttribute("aria-label", `Download ${key}`);
    dl.textContent = "↓";
    head.append(title, dl);

    const waveWrap = document.createElement("div");
    waveWrap.className = "waveform-wrap empty";
    waveWrap.id = `wave-${key}`;
    waveWrap.textContent = "—";

    const audio = document.createElement("audio");
    audio.id = `audio-${key}`;
    audio.preload = "auto";

    bindWaveformPlayback(key, waveWrap, audio);

    card.append(head, waveWrap, audio);
    return card;
  }

  function buildGrid() {
    const grid = root.querySelector("#sound-grid");
    if (!grid) return;
    mountKitLayoutShell(grid, {
      synthKeys: [...getSynthKeys(kitGenre, lastKitSeed, lastKitSpice)],
      appendCard: buildKitCard,
      genre: kitGenre,
    });
  }

  function bindWaveformPlayback(key, waveWrap, audio) {
    const setClickFull = (v) => clickFullPlayback.set(key, v);
    audio.addEventListener("ended", () => setClickFull(false));
    waveWrap.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
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
  }

  function renderWaveform(key, dataUrl) {
    const container = root.querySelector(`#wave-${key}`);
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
    const waveH = Math.max(68, Math.floor(container.clientHeight) || 68);
    const wsur = WaveSurfer.create({
      container,
      height: waveH,
      waveColor: "#b01010",
      progressColor: "#ffffff",
      cursorWidth: 0,
      interact: false,
      url: dataUrl,
    });
    waveSurfers.set(key, wsur);
  }

  function afterLayout(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }

  function attachSounds(sounds) {
    destroyWaveSurfers();
    audioSrcByKey.clear();
    clickFullPlayback.clear();
    getKitSoundKeys(kitGenre, lastKitSeed, lastKitSpice).forEach((key) => {
      const b64 = sounds[key];
      if (!b64) return;
      const src = base64ToAudioSrc(b64);
      audioSrcByKey.set(key, src);
      const audio = root.querySelector(`#audio-${key}`);
      if (audio instanceof HTMLAudioElement) audio.src = src;
    });
    afterLayout(() => {
      getKitSoundKeys(kitGenre, lastKitSeed, lastKitSpice).forEach((key) => {
        const src = audioSrcByKey.get(key);
        if (src) renderWaveform(key, src);
      });
    });
  }

  function setKitUiVisible(visible) {
    const gen = root.querySelector("#btn-generate");
    const kitActions = root.querySelector("#kit-actions");
    const grid = root.querySelector("#sound-grid");
    if (visible) {
      gen?.classList.add("hidden");
      kitActions?.classList.remove("hidden");
      grid?.classList.remove("hidden");
    } else {
      gen?.classList.remove("hidden");
      kitActions?.classList.add("hidden");
      grid?.classList.add("hidden");
    }
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function downloadAllAsZip() {
    if (!lastSoundsB64) return;
    const JSZip = getJSZip();
    const zip = new JSZip();
    const folder = zip.folder("beat_battle_kit");
    if (!folder) return;
    for (const key of getKitSoundKeys(kitGenre, lastKitSeed, lastKitSpice)) {
      const b64 = lastSoundsB64[key];
      if (!b64) continue;
      folder.file(`${key}.${KIT_SOUND_FILE_EXT}`, base64ToBytes(b64), {
        binary: true,
      });
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

  function downloadOneSound(key) {
    if (!lastSoundsB64) return;
    const b64 = lastSoundsB64[key];
    if (!b64) return;
    const blob = new Blob([base64ToBytes(b64)], { type: "audio/ogg" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${key}.${KIT_SOUND_FILE_EXT}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function generateKit() {
    const status = root.querySelector("#status");
    const btnGen = root.querySelector("#btn-generate");
    const btnReg = root.querySelector("#btn-regenerate");
    const spiceNum =
      normalizeKitGenre(kitGenre) === "edm" ? EDM_FIXED_SPICE : selectedSpice;

    const loading = () => {
      if (status) status.textContent = "";
      if (btnGen instanceof HTMLButtonElement) btnGen.disabled = true;
      if (btnReg instanceof HTMLButtonElement) btnReg.disabled = true;
    };
    const doneLoading = () => {
      if (btnGen instanceof HTMLButtonElement) btnGen.disabled = false;
      if (btnReg instanceof HTMLButtonElement) btnReg.disabled = false;
    };

    playSfxMajor();
    clearKitLoadUi();
    loading();

    const seed = Math.floor(Math.random() * 0x80000000);
    const base = resolveApiBase(ctx);
    const loadLayer = document.createElement("div");
    loadLayer.className = "synth-reveal-overlay";
    loadLayer.setAttribute("role", "status");
    loadLayer.innerHTML =
      '<p class="arcade-status" id="solo-kit-load">Loading kit…</p>';
    document.body.appendChild(loadLayer);
    activeKitOverlay = loadLayer;
    const loadEl = loadLayer.querySelector("#solo-kit-load");

    const ac = new AudioContext({ sampleRate: 44100 });
    activeKitAc = ac;
    let drumsPending = true;

    try {
      const manifest = await fetchKitManifest(base, kitGenre);
      const drumPromise = loadDrumKitBase64Parallel({
        seed,
        spice: spiceNum,
        apiBase: base,
        manifest,
        genre: kitGenre,
        onProgress: ({ step, total }) => {
          if (loadEl) loadEl.textContent = `Loading kit ${step} / ${total}…`;
        },
      }).finally(() => {
        drumsPending = false;
      });

      const { buffers: synthBuffers, base64: synthB64 } =
        await loadSynthBuffersAndMp3Base64Parallel({
          seed,
          spice: spiceNum,
          apiBase: base,
          audioContext: ac,
          manifest,
          genre: kitGenre,
        });

      if (loadEl) loadEl.textContent = "";
      loadLayer.remove();
      activeKitOverlay = null;

      await runSynthReveal(ac, synthBuffers, () => drumsPending, {
        synthKeys: [...getSynthKeys(kitGenre, seed, spiceNum)],
        genre: kitGenre,
      });

      const drumSounds = await drumPromise;
      const sounds = { ...drumSounds, ...synthB64 };

      await ac.close().catch(() => {});
      activeKitAc = null;

      lastKitSeed = seed;
      lastKitSpice = spiceNum;
      lastSoundsB64 = sounds;
      buildGrid();
      setKitUiVisible(true);
      attachSounds(sounds);
    } catch (e) {
      console.error(e);
      clearKitLoadUi();
      if (status) {
        status.textContent =
          e instanceof Error
            ? e.message
            : "Could not load kit. Is the API running?";
      }
    } finally {
      doneLoading();
    }
  }

  root
    .querySelector("#btn-generate")
    ?.addEventListener("click", () => generateKit());
  root
    .querySelector("#btn-regenerate")
    ?.addEventListener("click", () => generateKit());
  root.querySelector("#btn-download-all")?.addEventListener("click", () => {
    playSfxMinor();
    downloadAllAsZip().catch((e) => {
      console.error(e);
      const st = root.querySelector("#status");
      if (st)
        st.textContent =
          e instanceof Error ? e.message : "Could not build ZIP.";
    });
  });

  root.querySelector("#sound-grid")?.addEventListener("click", (e) => {
    const btn =
      e.target instanceof Element ? e.target.closest(".card-download") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    e.preventDefault();
    e.stopPropagation();
    const key = btn.dataset.soundKey;
    if (!key) return;
    playSfxMinor();
    downloadOneSound(key);
  });

  return () => {
    clearKitLoadUi();
    destroyWaveSurfers();
    root.innerHTML = "";
  };
}
