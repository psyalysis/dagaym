/**
 * Big synth reveal — pinned to document.body so nothing clips it.
 */
import { SYNTH_KEYS, normalizeKitGenre } from "./kitFromSeed.js";
import { kitSlotDisplayLabel } from "./kitGridLayout.js";

const REVEAL_STAGGER_MS = 1000;
const SYNTH_PREVIEW_MAX_SEC = 2;
/** Browsers sometimes ghost onended — pad the end a bit. */
const PREVIEW_END_GRACE_MS = 400;
/** Don't wait on drums forever if the net's being weird. */
const WAIT_FOR_DRUMS_MAX_MS = 120_000;

/**
 * @param {AudioContext} audioContext
 * @param {AudioBuffer | undefined} buffer
 * @param {AbortSignal | undefined} signal
 */
function playSynthPreview(audioContext, buffer, signal) {
  return new Promise((resolve, reject) => {
    if (!buffer) {
      resolve();
      return;
    }
    const rawDur = buffer.duration;
    if (!Number.isFinite(rawDur) || rawDur <= 0) {
      resolve();
      return;
    }
    const dur = Math.min(SYNTH_PREVIEW_MAX_SEC, rawDur);
    const src = audioContext.createBufferSource();
    src.buffer = buffer;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let watchdog;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const onAbort = () => {
      try {
        src.stop(0);
      } catch {
        /* ignore */
      }
      finish();
    };
    if (signal) {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    src.onended = finish;
    src.connect(audioContext.destination);
    const ms = Math.ceil(dur * 1000) + PREVIEW_END_GRACE_MS;
    watchdog = window.setTimeout(finish, ms);
    void audioContext
      .resume()
      .catch(() => {})
      .then(() => {
        try {
          src.start(0, 0, dur);
        } catch (e) {
          if (watchdog !== undefined) window.clearTimeout(watchdog);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (!settled) {
            settled = true;
            reject(e);
          }
        }
      });
  });
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function delayWithAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Vertical offset for stacked cards (px). Matches previous 3-card spread (~34, 17, 0).
 * @param {number} index
 * @param {number} total
 */
function stackOffsetYpx(index, total) {
  if (total <= 1) return 0;
  const step = total <= 3 ? 17 : Math.max(8, Math.round(51 / (total - 1)));
  return (total - 1 - index) * step;
}

/**
 * Card label for the reveal (distinct from grid labels when needed).
 * @param {string} key
 * @param {string} genre
 * @returns {string}
 */
function synthRevealTitle(key, genre) {
  if (normalizeKitGenre(genre) === "edm") {
    return kitSlotDisplayLabel(key, genre);
  }
  const trap = /** @type {Record<string, string>} */ ({
    synth1: "Synth 1",
    synth2: "Synth 2",
    synth3: "Synth 3",
  });
  return trap[key] ?? key;
}

function synthRevealHeading(genre) {
  return normalizeKitGenre(genre) === "edm"
    ? "Your 4 synths:"
    : "Your 3 synths:";
}

function waitForDrums(drumsStillLoading) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tryFinish = () => {
      if (!drumsStillLoading()) {
        setTimeout(resolve, 160);
        return;
      }
      if (Date.now() - t0 >= WAIT_FOR_DRUMS_MAX_MS) {
        resolve();
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
 * @param {{ synthKeys?: string[]; genre?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function runSynthReveal(
  audioContext,
  synthBuffers,
  drumsStillLoading,
  opts = {},
) {
  const keys = opts.synthKeys ?? SYNTH_KEYS;
  const genre = opts.genre ?? "trap";

  const layer = document.createElement("div");
  layer.className = "synth-reveal-overlay";
  layer.setAttribute("role", "dialog");
  layer.setAttribute("aria-modal", "true");
  layer.setAttribute("aria-label", "Your synths");

  const wrap = document.createElement("div");
  wrap.className = "synth-reveal";
  const heading = document.createElement("h2");
  heading.className = "arcade-heading synth-reveal-heading";
  heading.textContent = synthRevealHeading(genre);
  const stack = document.createElement("div");
  stack.className = "synth-reveal-stack";
  if (keys.length > 3) stack.classList.add("synth-reveal-stack--many");
  stack.setAttribute("aria-live", "polite");
  /** @type {HTMLElement[]} */
  const cards = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const title = synthRevealTitle(key, genre);
    const card = document.createElement("div");
    card.className = "synth-card";
    card.dataset.synthI = String(i);
    card.style.setProperty("--placed-y", `${stackOffsetYpx(i, keys.length)}px`);
    card.setAttribute("aria-label", title);
    const lab = document.createElement("span");
    lab.className = "synth-card-label";
    lab.textContent = title;
    card.appendChild(lab);
    stack.appendChild(card);
    cards.push(card);
  }
  const sub = document.createElement("p");
  sub.className = "arcade-hint synth-reveal-sub";
  sub.id = "synth-reveal-sub";
  wrap.append(heading, stack, sub);
  layer.appendChild(wrap);
  document.body.appendChild(layer);

  const tickHint = () => {
    const parts = ["Click to skip."];
    if (drumsStillLoading()) parts.push("Loading drums…");
    if (sub) sub.textContent = parts.join(" ");
  };

  try {
    for (let step = 0; step < keys.length; step++) {
      tickHint();
      const card = cards[step];
      const key = keys[step];
      const buf = synthBuffers[key];

      const skipStep = new AbortController();
      const onSkip = () => skipStep.abort();
      layer.addEventListener("pointerdown", onSkip);

      try {
        if (card) {
          await new Promise((r) => requestAnimationFrame(r));
          card.style.zIndex = String(10 + step);
          card.classList.add("synth-card--in");
          void card.offsetWidth;
          card.classList.add("synth-card--placed");
        }

        await playSynthPreview(audioContext, buf, skipStep.signal);
        await delayWithAbort(REVEAL_STAGGER_MS, skipStep.signal);
      } finally {
        layer.removeEventListener("pointerdown", onSkip);
      }
    }

    tickHint();
    await Promise.race([
      waitForDrums(drumsStillLoading),
      new Promise((resolve) => {
        layer.addEventListener("pointerdown", resolve, { once: true });
      }),
    ]);
  } finally {
    layer.remove();
  }
}
