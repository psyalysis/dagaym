/**
 * Shared “Here are your synths!” sequence (multiplayer cook + solo).
 */
import { playBufferOnce, SYNTH_KEYS } from "./kitFromSeed.js";

const REVEAL_STAGGER_MS = 2000;

/**
 * Replaces ``container`` inner HTML with the reveal UI; resolves when done (and drums ready).
 * @param {HTMLElement} container
 * @param {AudioContext} audioContext
 * @param {Record<string, AudioBuffer>} synthBuffers
 * @param {() => boolean} drumsStillLoading
 * @returns {Promise<void>}
 */
export function runSynthReveal(container, audioContext, synthBuffers, drumsStillLoading) {
  return new Promise((resolve) => {
    container.innerHTML = `
    <div class="synth-reveal synth-reveal--embed arcade-panel">
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
    const sub = container.querySelector("#synth-reveal-sub");
    const cards = /** @type {HTMLElement[]} */ ([
      container.querySelector('[data-synth-i="0"]'),
      container.querySelector('[data-synth-i="1"]'),
      container.querySelector('[data-synth-i="2"]'),
    ]);
    const keys = SYNTH_KEYS;
    let step = 0;

    const tickHint = () => {
      const extra = drumsStillLoading() ? "Loading drums…" : "";
      if (sub) sub.textContent = extra;
    };

    const finish = () => {
      tickHint();
      if (!drumsStillLoading()) {
        setTimeout(resolve, 160);
        return;
      }
      const id = setInterval(() => {
        tickHint();
        if (!drumsStillLoading()) {
          clearInterval(id);
          setTimeout(resolve, 160);
        }
      }, 120);
    };

    const next = () => {
      tickHint();
      if (step >= 3) {
        finish();
        return;
      }
      const card = cards[step];
      const key = keys[step];
      if (card) {
        requestAnimationFrame(() => {
          /* Newest reveal on top of the pile (higher step → higher z-index). */
          card.style.zIndex = String(10 + step);
          card.classList.add("synth-card--in");
          void card.offsetWidth;
          card.classList.add("synth-card--placed");
        });
      }
      const buf = synthBuffers[key];
      if (buf) playBufferOnce(audioContext, buf);
      step += 1;
      setTimeout(next, REVEAL_STAGGER_MS);
    };

    tickHint();
    requestAnimationFrame(() => next());
  });
}
