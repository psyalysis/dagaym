/**
 * Cursor-following tooltips for .corner-social-link anchors with data-corner-tooltip.
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
  const stack = document.querySelector(".corner-social-stack");
  if (!stack) return;

  let tip = document.getElementById("corner-social-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "corner-social-tooltip";
    tip.className = "corner-social-tooltip corner-social-tooltip--hidden";
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    document.body.appendChild(tip);
  }

  const links = stack.querySelectorAll("a.corner-social-link[data-corner-tooltip]");
  if (!links.length) return;

  let label = "";

  const hide = () => {
    tip.classList.add("corner-social-tooltip--hidden");
    tip.setAttribute("aria-hidden", "true");
    label = "";
  };

  /** @param {PointerEvent} ev */
  const onMove = (ev) => {
    if (!label) return;
    tip.textContent = label;
    positionTip(tip, ev.clientX, ev.clientY);
  };

  for (const a of links) {
    a.addEventListener("pointerenter", (ev) => {
      const t = a.getAttribute("data-corner-tooltip");
      if (!t) return;
      label = t;
      tip.textContent = label;
      positionTip(tip, ev.clientX, ev.clientY);
      tip.classList.remove("corner-social-tooltip--hidden");
      tip.setAttribute("aria-hidden", "false");
    });
    a.addEventListener("pointermove", onMove);
    a.addEventListener("pointerleave", hide);
    a.addEventListener("pointercancel", hide);
  }
}
