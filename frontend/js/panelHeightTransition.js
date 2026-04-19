/** Shared smooth height transition (mode select, genre/spice, cross-screen nav). */

export const PANEL_HEIGHT_TRANSITION_MS = 280;
const PANEL_HEIGHT_EASE = "ease-out";

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Panel must already have inline height set to the start value. */
function runPanelHeightAnimation(panel, endPx) {
  const endRounded = Math.round(endPx * 1000) / 1000;

  panel.style.transition = `height ${PANEL_HEIGHT_TRANSITION_MS / 1000}s ${PANEL_HEIGHT_EASE}`;

  requestAnimationFrame(() => {
    panel.style.height = `${endRounded}px`;
  });

  let cleaned = false;
  let fallbackId = 0;

  const finish = () => {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(fallbackId);
    panel.removeEventListener("transitionend", onTransitionEnd);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        panel.style.height = "";
        panel.style.overflow = "";
        panel.style.transition = "";
      });
    });
  };

  /** @param {TransitionEvent} e */
  function onTransitionEnd(e) {
    if (e.propertyName !== "height") return;
    if (e.target !== panel) return;
    finish();
  }

  panel.addEventListener("transitionend", onTransitionEnd);
  fallbackId = window.setTimeout(finish, PANEL_HEIGHT_TRANSITION_MS + 80);
}

/**
 * After swapping screen markup: animate this panel from the previous screen's height.
 * @param {HTMLElement | null} panel
 * @param {number | null} previousHeight
 */
export function transitionPanelEnterFromHeight(panel, previousHeight) {
  if (!panel || previousHeight == null || previousHeight <= 0) return;
  if (prefersReducedMotion()) return;

  const start = previousHeight;
  panel.style.height = `${start}px`;
  panel.style.overflow = "hidden";
  void panel.offsetHeight;

  panel.style.height = "auto";
  const end = panel.getBoundingClientRect().height;
  panel.style.height = `${start}px`;
  void panel.offsetHeight;

  if (Math.abs(end - start) < 0.5) {
    panel.style.height = "";
    panel.style.overflow = "";
    return;
  }

  runPanelHeightAnimation(panel, end);
}

/**
 * Smoothly resize a panel when inner content height changes (e.g. show/hide a block).
 * @param {HTMLElement | null} panel
 * @param {() => void} updateDom
 */
export function transitionPanelHeight(panel, updateDom) {
  if (!panel) {
    updateDom();
    return;
  }
  if (prefersReducedMotion()) {
    updateDom();
    return;
  }

  const start = panel.getBoundingClientRect().height;
  panel.style.height = `${start}px`;
  panel.style.overflow = "hidden";

  updateDom();
  void panel.offsetHeight;

  // Shrinking content: locked height makes scrollHeight lie — measure at height:auto first.
  panel.style.height = "auto";
  const end = panel.getBoundingClientRect().height;
  panel.style.height = `${start}px`;
  void panel.offsetHeight;

  if (Math.abs(end - start) < 0.5) {
    panel.style.height = "";
    panel.style.overflow = "";
    return;
  }

  runPanelHeightAnimation(panel, end);
}

/** Primary card on a full-screen view (see screen mounts). */
export function queryPrimaryArcadePanel(root) {
  if (!(root instanceof HTMLElement)) return null;
  return (
    root.querySelector(".screen.arcade-panel") ??
    root.querySelector(".arcade-panel")
  );
}
