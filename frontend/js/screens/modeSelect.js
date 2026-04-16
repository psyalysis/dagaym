/**
 * Pick solo or jump into multiplayer.
 */
import { isLoggedIn } from "../authApi.js";
import { RANK_PENDING_KEY, showRankUpOverlay } from "../rankUi.js";
import { mountAuthCornerGuest, mountAuthCornerMenu } from "../authCorner.js";
import { playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountSoloScreen } from "../solo.js";

const CHILI_SRC = new URL("../../imgs/chili.png", import.meta.url).href;

const MP_LOCK_MSG = "Log in to play multiplayer.";

const MODE_PANEL_HEIGHT_MS = 280;
const MODE_PANEL_EASE = "ease-out";

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Smoothly resize the central panel when landing vs mode-choice content changes.
 * @param {HTMLElement | null} panel
 * @param {() => void} updateDom
 */
function transitionModeSelectPanel(panel, updateDom) {
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

  const end = panel.scrollHeight;
  if (Math.abs(end - start) < 0.5) {
    panel.style.height = "";
    panel.style.overflow = "";
    return;
  }

  panel.style.transition = `height ${MODE_PANEL_HEIGHT_MS / 1000}s ${MODE_PANEL_EASE}`;

  requestAnimationFrame(() => {
    panel.style.height = `${end}px`;
  });

  let cleaned = false;
  let fallbackId = 0;

  const finish = () => {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(fallbackId);
    panel.style.height = "";
    panel.style.overflow = "";
    panel.style.transition = "";
    panel.removeEventListener("transitionend", onTransitionEnd);
  };

  /** @param {TransitionEvent} e */
  function onTransitionEnd(e) {
    if (e.propertyName !== "height") return;
    finish();
  }

  panel.addEventListener("transitionend", onTransitionEnd);
  fallbackId = window.setTimeout(finish, MODE_PANEL_HEIGHT_MS + 80);
}

function multiplayerButtonHtml() {
  return isLoggedIn()
    ? `<button type="button" class="arcade-btn arcade-btn-primary" id="btn-mp">Multiplayer</button>`
    : `<button type="button" class="arcade-btn arcade-btn-primary arcade-btn--locked" id="btn-mp" title="${MP_LOCK_MSG}" aria-label="Multiplayer (${MP_LOCK_MSG})">
        <span class="arcade-btn-lock" aria-hidden="true">&#128274;</span>
        <span class="arcade-btn-label">Multiplayer</span>
      </button>`;
}

export function mountModeSelectScreen(root, ctx) {
  const loggedIn = isLoggedIn();

  const mpButtonHtml = multiplayerButtonHtml();

  root.innerHTML = `
    <div class="home-screen screen--vert-center">
      <div class="home-chili-wrap" aria-hidden="true">
        <img src="${CHILI_SRC}" class="home-chili" width="96" height="96" alt="" decoding="async" />
      </div>
      <div class="screen mode-select arcade-panel">
        <h1 class="arcade-title">BEAT BATTLE</h1>
        <p class="arcade-tagline mode-select-tagline--concealed" id="mode-select-tagline" aria-hidden="true">Choose Your Mode</p>
        <div class="arcade-actions arcade-actions--mode arcade-actions--mode-stack">
          <div id="mode-select-step-home" class="mode-select-step">
            <button type="button" class="arcade-btn arcade-btn-primary" id="btn-play">Play</button>
            <button type="button" class="arcade-btn arcade-btn-primary" id="btn-leaderboard">Leaderboard</button>
          </div>
          <div id="mode-select-step-modes" class="mode-select-step" hidden>
            <button type="button" class="arcade-btn arcade-btn-primary" id="btn-solo">Solo</button>
            ${mpButtonHtml}
          </div>
        </div>
        <p class="arcade-hint mode-mp-lock-hint" id="mp-lock-hint" hidden></p>
        <p class="mode-select-back-wrap"><button type="button" class="mode-select-back" id="mode-select-back" hidden>Back</button></p>
      </div>
    </div>
  `;

  if (loggedIn) {
    mountAuthCornerMenu(ctx, { logoutOnly: true });
  } else {
    mountAuthCornerGuest(ctx, { showHome: false });
  }

  try {
    const raw = sessionStorage.getItem(RANK_PENDING_KEY);
    if (raw) {
      sessionStorage.removeItem(RANK_PENDING_KEY);
      const data = JSON.parse(raw);
      if (data && typeof data === "object") showRankUpOverlay(data);
    }
  } catch {
    /* ignore */
  }

  const stepHome = root.querySelector("#mode-select-step-home");
  const stepModes = root.querySelector("#mode-select-step-modes");
  const tagline = root.querySelector("#mode-select-tagline");
  const backBtn = root.querySelector("#mode-select-back");
  const playBtn = root.querySelector("#btn-play");
  const leaderboardBtn = root.querySelector("#btn-leaderboard");
  const solo = root.querySelector("#btn-solo");
  const mp = root.querySelector("#btn-mp");
  const lockHint = root.querySelector("#mp-lock-hint");
  const panel = root.querySelector(".mode-select.arcade-panel");

  const goMultiplayerHub = () => {
    if (!isLoggedIn()) {
      playSfxMinor();
      if (lockHint) {
        lockHint.textContent = MP_LOCK_MSG;
        lockHint.hidden = false;
      }
      return;
    }
    playSfxMajor();
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
  };

  const showModeChoice = () => {
    transitionModeSelectPanel(panel instanceof HTMLElement ? panel : null, () => {
      if (stepHome) stepHome.hidden = true;
      if (stepModes) stepModes.hidden = false;
      if (tagline) {
        tagline.classList.remove("mode-select-tagline--concealed");
        tagline.setAttribute("aria-hidden", "false");
      }
      if (backBtn) backBtn.hidden = false;
    });
  };

  const showHomeLanding = () => {
    transitionModeSelectPanel(panel instanceof HTMLElement ? panel : null, () => {
      if (stepHome) stepHome.hidden = false;
      if (stepModes) stepModes.hidden = true;
      if (tagline) {
        tagline.classList.add("mode-select-tagline--concealed");
        tagline.setAttribute("aria-hidden", "true");
      }
      if (backBtn) backBtn.hidden = true;
      if (lockHint) lockHint.hidden = true;
    });
  };

  playBtn?.addEventListener("click", () => {
    playSfxMinor();
    showModeChoice();
  });

  backBtn?.addEventListener("click", () => {
    playSfxMinor();
    showHomeLanding();
  });

  leaderboardBtn?.addEventListener("click", () => {
    playSfxMajor();
    import("./leaderboardScreen.js").then((m) => ctx.navigate(m.mountLeaderboardScreen));
  });

  solo?.addEventListener("click", () => {
    playSfxMajor();
    ctx.navigate(mountSoloScreen);
  });

  mp?.addEventListener("click", goMultiplayerHub);

  return () => {
    root.innerHTML = "";
  };
}
