/**
 * Full-viewport synth reveal (appended to document.body). Not clipped by app-root / screen bounds.
 */
import { SYNTH_KEYS } from "./kitFromSeed.js";

const REVEAL_STAGGER_MS = 1000;
const SYNTH_PREVIEW_MAX_SEC = 2;

function playSynthPreview(audioContext, buffer) {
  return new Promise((resolve, reject) => {
    if (!buffer) {
      resolve();
      return;
    }
    const dur = Math.min(SYNTH_PREVIEW_MAX_SEC, buffer.duration);
    if (dur <= 0) {
      resolve();
      return;
    }
    const src = audioContext.createBufferSource();
    src.buffer = buffer;
    src.onended = () => resolve();
    src.connect(audioContext.destination);
    void audioContext.resume().catch(() => {});
    try {
      src.start(0, 0, dur);
    } catch (e) {
      reject(e);
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForDrums(drumsStillLoading) {
  return new Promise((resolve) => {
    const tryFinish = () => {
      if (!drumsStillLoading()) {
        setTimeout(resolve, 160);
        return;
      }
      setTimeout(tryFinish, 120);
    };
    tryFinish();
  });
}

/**
 * @param {AudioContext} audioContext
 * @param {Record<string, AudioBuffer>} synthBuffers
 * @param {() => boolean} drumsStillLoading
 * @returns {Promise<void>}
 */
export async function runSynthReveal(audioContext, synthBuffers, drumsStillLoading) {
  const layer = document.createElement("div");
  layer.className = "synth-reveal-overlay";
  layer.setAttribute("role", "dialog");
  layer.setAttribute("aria-modal", "true");
  layer.setAttribute("aria-label", "Your synths");
  layer.innerHTML = `
    <div class="synth-reveal">
      <h2 class="arcade-heading synth-reveal-heading">Here are your synths!</h2>
      <div class="synth-reveal-stack" aria-live="polite">
        <div class="synth-card" data-synth-i="0">
          <span class="synth-card-label">Synth 1</span>
        </div>
        <div class="synth-card" data-synth-i="1">
          <span class="synth-card-label">Synth 2</span>
        </div>
        <div class="synth-card" data-synth-i="2">
          <span class="synth-card-label">Synth 3</span>
        </div>
      </div>
      <p class="arcade-hint synth-reveal-sub" id="synth-reveal-sub"></p>
    </div>`;
  document.body.appendChild(layer);

  const sub = layer.querySelector("#synth-reveal-sub");
  const cards = /** @type {HTMLElement[]} */ ([
    layer.querySelector('[data-synth-i="0"]'),
    layer.querySelector('[data-synth-i="1"]'),
    layer.querySelector('[data-synth-i="2"]'),
  ]);
  const keys = SYNTH_KEYS;

  const tickHint = () => {
    const extra = drumsStillLoading() ? "Loading drums…" : "";
    if (sub) sub.textContent = extra;
  };

  try {
    for (let step = 0; step < 3; step++) {
      tickHint();
      const card = cards[step];
      const key = keys[step];
      const buf = synthBuffers[key];

      if (card) {
        await new Promise((r) => requestAnimationFrame(r));
        card.style.zIndex = String(10 + step);
        card.classList.add("synth-card--in");
        void card.offsetWidth;
        card.classList.add("synth-card--placed");
      }

      await playSynthPreview(audioContext, buf);
      await delay(REVEAL_STAGGER_MS);
    }

    tickHint();
    await waitForDrums(drumsStillLoading);
  } finally {
    layer.remove();
  }
}
