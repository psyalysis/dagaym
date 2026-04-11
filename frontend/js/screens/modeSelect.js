/**
 * ModeSelectScreen — Solo Cook vs Multiplayer Cook.
 */
import { isLoggedIn } from "../authApi.js";
import { RANK_PENDING_KEY, showRankUpOverlay } from "../rankUi.js";
import { mountAuthCornerGuest, mountAuthCornerMenu } from "../authCorner.js";
import { playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountSoloScreen } from "../solo.js";

const CHILI_SRC = new URL("../../imgs/chili.png", import.meta.url).href;

const MP_LOCK_MSG = "Log in to play multiplayer.";

export function mountModeSelectScreen(root, ctx) {
  const loggedIn = isLoggedIn();

  const mpButtonHtml = loggedIn
    ? `<button type="button" class="arcade-btn arcade-btn-primary" id="btn-mp">Multiplayer</button>`
    : `<button type="button" class="arcade-btn arcade-btn-primary arcade-btn--locked" id="btn-mp" title="${MP_LOCK_MSG}" aria-label="Multiplayer (${MP_LOCK_MSG})">
        <span class="arcade-btn-lock" aria-hidden="true">&#128274;</span>
        <span class="arcade-btn-label">Multiplayer</span>
      </button>`;

  root.innerHTML = `
    <div class="home-screen screen--vert-center">
      <div class="home-chili-wrap" aria-hidden="true">
        <img src="${CHILI_SRC}" class="home-chili" width="96" height="96" alt="" decoding="async" />
      </div>
      <div class="screen mode-select arcade-panel">
        <h1 class="arcade-title">BEAT BATTLE</h1>
        <p class="arcade-tagline">Choose your mode</p>
        <div class="arcade-actions arcade-actions--mode">
          <button type="button" class="arcade-btn arcade-btn-primary" id="btn-solo">Solo</button>
          ${mpButtonHtml}
        </div>
        <p class="arcade-hint mode-mp-lock-hint" id="mp-lock-hint" hidden></p>
      </div>
    </div>
  `;

  if (loggedIn) {
    mountAuthCornerMenu(ctx, { primary: "leaderboard" });
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

  const solo = root.querySelector("#btn-solo");
  const mp = root.querySelector("#btn-mp");
  const lockHint = root.querySelector("#mp-lock-hint");

  solo?.addEventListener("click", () => {
    playSfxMajor();
    ctx.navigate(mountSoloScreen);
  });

  mp?.addEventListener("click", () => {
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
  });

  return () => {
    root.innerHTML = "";
  };
}
