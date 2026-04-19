/**
 * Heart in the corner opens this — full-screen credits.
 */
import { playSfxMinor } from "./sfx.js";

const OVERLAY_ID = "credits-overlay";

/**
 * @typedef {{
 *   name: string,
 *   contribution: string,
 *   profileUsername?: string,
 * }} CreditEntry
 */

/** This is for the mf on the credits <3 */
/** @type {CreditEntry[]} */
const CREDITS = [
  {
    name: "psyalysis",
    contribution: "Original creator of the game!",
    profileUsername: "psyalysis",
  },
  {
    name: "dracocaine",
    contribution: "Network and Connections | Community Strategist | Visionary",
    profileUsername: "dracocaine",
  },
  {
    name: "lukasz",
    contribution: "Discord Admin",
  },
  {
    name: "inboredom",
    contribution: "UI Sound Design | Trimming Samples",
    profileUsername: "inboredom",
  },
  {
    name: "sarcasmo",
    contribution: "Menu Pixel Icons",
  },
  {
    name: "danny / danro (discord)",
    contribution: "Pixel Art Rank Icons",
    profileUsername: "danro",
  },
  {
    name: "sebben",
    contribution: "Tuning Samples",
    profileUsername: "sebben",
  },
  {
    name: "prod.jawn",
    contribution: "Beat Buck Icon",
    profileUsername: "prodjawn",
  },
];

/**
 * @param {(mountFn: (root: HTMLElement, ctx: object) => () => void, extra?: object) => void} [navigate]
 */
export function openCreditsOverlay(navigate) {
  if (document.getElementById(OVERLAY_ID)) return;

  const el = document.createElement("div");
  el.id = OVERLAY_ID;
  el.className = "credits-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "credits-overlay-title");

  const onKeyDown = (/** @type {KeyboardEvent} */ ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  };

  const close = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    el.classList.remove("credits-overlay--visible");
    window.setTimeout(() => el.remove(), 220);
  };

  el.addEventListener("click", (ev) => {
    if (ev.target === el) close();
  });

  const panel = document.createElement("div");
  panel.className = "credits-panel";
  panel.addEventListener("click", (ev) => ev.stopPropagation());

  const title = document.createElement("h2");
  title.id = "credits-overlay-title";
  title.className = "credits-panel-title";
  title.textContent = "Credits";

  const list = document.createElement("ul");
  list.className = "credits-list";

  for (const c of CREDITS) {
    const li = document.createElement("li");
    li.className = "credits-entry";

    const slug = (c.profileUsername || "").trim();
    /** @type {HTMLElement} */
    let nameEl;
    if (slug && typeof navigate === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "credits-entry-name credits-entry-name--link";
      btn.textContent = c.name;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        playSfxMinor();
        close();
        history.pushState(
          { profile: slug },
          "",
          `/@${encodeURIComponent(slug)}`,
        );
        import("./screens/profileScreen.js").then((m) =>
          navigate(m.mountProfileScreen, {
            profileUsername: slug,
            skipPanelEnterTransition: true,
          }),
        );
      });
      nameEl = btn;
    } else {
      const p = document.createElement("p");
      p.className = "credits-entry-name";
      p.textContent = c.name;
      nameEl = p;
    }

    const roleEl = document.createElement("p");
    roleEl.className = "credits-entry-role";
    roleEl.textContent = c.contribution;

    li.append(nameEl, roleEl);
    list.appendChild(li);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "arcade-btn arcade-btn-secondary credits-panel-close";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", close);

  panel.append(title, list, closeBtn);
  el.appendChild(panel);
  document.body.appendChild(el);
  document.addEventListener("keydown", onKeyDown, true);
  requestAnimationFrame(() => el.classList.add("credits-overlay--visible"));
}

/**
 * @param {HTMLElement} btn
 * @param {{ navigate?: (mountFn: (root: HTMLElement, ctx: object) => () => void, extra?: object) => void }} [ctx]
 */
export function initCreditsCornerControl(btn, ctx = {}) {
  btn.addEventListener("click", () => openCreditsOverlay(ctx.navigate));
}
