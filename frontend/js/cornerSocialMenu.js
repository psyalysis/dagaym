/**
 * Top-left corner: one trigger expands to reveal coffee, Discord, credits.
 */
import { playSfxOff, playSfxOn } from "./sfx.js";

const OPEN_CLASS = "corner-social-menu--open";

/**
 * @param {HTMLElement} root
 */
export function initCornerSocialMenu(root) {
  const toggle = root.querySelector(".corner-social-menu-toggle");
  const panel = root.querySelector("#corner-social-menu-panel");
  if (!(toggle instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) return;

  const setOpen = (open) => {
    if (root.classList.contains(OPEN_CLASS) === open) return;
    root.classList.toggle(OPEN_CLASS, open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    toggle.setAttribute("aria-label", open ? "Close links menu" : "Open links menu");
    if (open) panel.removeAttribute("inert");
    else panel.setAttribute("inert", "");
    if (open) playSfxOn();
    else playSfxOff();
  };

  toggle.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(!root.classList.contains(OPEN_CLASS));
  });

  document.addEventListener(
    "click",
    (ev) => {
      if (!root.classList.contains(OPEN_CLASS)) return;
      const t = ev.target;
      if (t instanceof Node && root.contains(t)) return;
      setOpen(false);
    },
    true,
  );

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && root.classList.contains(OPEN_CLASS)) {
      setOpen(false);
      toggle.focus();
    }
  });
}
