/**
 * Cursor-following tooltips for any element with `data-corner-tooltip` (delegated).
 * Same UX as the corner social links.
 */

const OFFSET_X = 14;
const OFFSET_Y = 18;
const VIEW_PAD = 10;

/**
 * @param {HTMLElement} el
 * @param {number} clientX
 * @param {number} clientY
 */
function positionTip(el, clientX, clientY) {
  el.style.left = `${clientX + OFFSET_X}px`;
  el.style.top = `${clientY + OFFSET_Y}px`;

  const rect = el.getBoundingClientRect();
  let x = clientX + OFFSET_X;
  let y = clientY + OFFSET_Y;

  if (rect.right > window.innerWidth - VIEW_PAD) {
    x = window.innerWidth - VIEW_PAD - rect.width;
  }
  if (rect.bottom > window.innerHeight - VIEW_PAD) {
    y = clientY - OFFSET_Y - rect.height;
  }
  if (x < VIEW_PAD) x = VIEW_PAD;
  if (y < VIEW_PAD) y = VIEW_PAD;

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

export function initCornerSocialTooltips() {
  let tip = document.getElementById("corner-social-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "corner-social-tooltip";
    tip.className = "corner-social-tooltip corner-social-tooltip--hidden";
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    document.body.appendChild(tip);
  }

  /** @type {HTMLElement | null} */
  let activeHost = null;
  let label = "";

  const hide = () => {
    tip.classList.add("corner-social-tooltip--hidden");
    tip.setAttribute("aria-hidden", "true");
    activeHost = null;
    label = "";
  };

  /** @param {PointerEvent} ev */
  const onPointerMove = (ev) => {
    if (!label) return;
    tip.textContent = label;
    positionTip(tip, ev.clientX, ev.clientY);
  };

  document.addEventListener(
    "pointerover",
    (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const host = t.closest("[data-corner-tooltip]");
      if (!(host instanceof HTMLElement)) return;
      const text = host.getAttribute("data-corner-tooltip");
      if (!text) return;
      if (activeHost === host) return;
      activeHost = host;
      label = text;
      tip.textContent = label;
      positionTip(tip, ev.clientX, ev.clientY);
      tip.classList.remove("corner-social-tooltip--hidden");
      tip.setAttribute("aria-hidden", "false");
    },
    true,
  );

  document.addEventListener("pointermove", onPointerMove, true);

  document.addEventListener(
    "pointerout",
    (ev) => {
      if (!activeHost) return;
      const next = ev.relatedTarget;
      if (next instanceof Node && activeHost.contains(next)) return;
      hide();
    },
    true,
  );

  document.addEventListener("pointercancel", hide, true);
}
