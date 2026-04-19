/**
 * Pick solo or jump into multiplayer.
 */
import { isLoggedIn, validateSession } from "../authApi.js";
import { setAppErrorContext } from "../errorToast.js";
import { showMpReconnectMenuOverlay } from "../mpReconnectMenuOverlay.js";
import {
  cleanupReconnectSuppressIfNoPending,
  fetchMpReconnectPending,
  shouldShowReconnectOverlay,
} from "../mpReconnectPending.js";
import { fetchMpPauseStatus, MP_PAUSE_MESSAGE } from "../mpPauseStatus.js";
import {
  hasSeenRankUp,
  RANK_PENDING_KEY,
  showRankUpOverlay,
} from "../rankUi.js";
import { mountAuthCornerGuest, mountAuthCornerMenu } from "../authCorner.js";
import { transitionPanelHeight } from "../panelHeightTransition.js";
import { playSfxMajor, playSfxMinor, playSfxOff, playSfxOn } from "../sfx.js";
import { mountSoloScreen } from "../solo.js";

const CHILI_SRC = new URL("../../imgs/chili.png", import.meta.url).href;

const MP_LOCK_MSG = "Log in to play multiplayer.";

function multiplayerButtonHtml() {
  return isLoggedIn()
    ? `<button type="button" class="arcade-btn arcade-btn-primary" id="btn-mp">Multiplayer</button>`
    : `<button type="button" class="arcade-btn arcade-btn-primary arcade-btn--locked" id="btn-mp" title="${MP_LOCK_MSG}" aria-label="Multiplayer (${MP_LOCK_MSG})">
        <span class="arcade-btn-lock" aria-hidden="true">&#128274;</span>
        <span class="arcade-btn-label">Multiplayer</span>
      </button>`;
}

/** @param {HTMLElement | null} el */
function setMpButtonLabel(el, label) {
  if (!el) return;
  const inner = el.querySelector(".arcade-btn-label");
  if (inner) inner.textContent = label;
  else el.textContent = label;
}

export function mountModeSelectScreen(root, ctx) {
  setAppErrorContext({ screen: "Home", phase: "Mode select" });
  const loggedIn = isLoggedIn();

  const mpButtonHtml = multiplayerButtonHtml();

  root.innerHTML = `
    <div class="home-screen screen--vert-center">
      <div class="home-chili-wrap" aria-hidden="true">
        <img src="${CHILI_SRC}" class="home-chili" width="96" height="96" alt="" decoding="async" />
      </div>
      <div class="screen mode-select arcade-panel">
        <div class="screen-topbar mode-select-topbar">
          <div class="screen-topbar-start">
            <span class="screen-topbar-lead-spacer" id="mode-select-lead-spacer" aria-hidden="true"></span>
            <button type="button" class="arcade-back" id="mode-select-back" aria-label="Back" hidden>&lt;</button>
          </div>
          <h1 class="arcade-title screen-topbar-title">BEAT BATTLE</h1>
          <span class="screen-topbar-spacer" aria-hidden="true"></span>
        </div>
        <p class="arcade-tagline mode-select-tagline--concealed" id="mode-select-tagline" aria-hidden="true">Choose Your Mode</p>
        <div class="arcade-actions arcade-actions--mode arcade-actions--mode-stack">
          <div id="mode-select-step-home" class="mode-select-step">
            <button type="button" class="arcade-btn arcade-btn-primary" id="btn-play">Play</button>
            <button type="button" class="arcade-btn arcade-btn-primary" id="btn-leaderboard">Leaderboard</button>
            <button type="button" class="arcade-btn arcade-btn-primary" id="btn-shop">Shop</button>
          </div>
          <div id="mode-select-step-modes" class="mode-select-step" hidden>
            <button type="button" class="arcade-btn arcade-btn-primary" id="btn-solo">Solo</button>
            ${mpButtonHtml}
          </div>
        </div>
        <p class="arcade-hint mode-mp-lock-hint" id="mp-lock-hint" hidden></p>
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
      if (data && typeof data === "object") {
        const k = data.key != null ? String(data.key) : "";
        if (!k || !hasSeenRankUp(k)) showRankUpOverlay(data);
      }
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
  const shopBtn = root.querySelector("#btn-shop");
  const solo = root.querySelector("#btn-solo");
  const mp = root.querySelector("#btn-mp");
  const lockHint = root.querySelector("#mp-lock-hint");
  const panel = root.querySelector(".mode-select.arcade-panel");

  if (loggedIn && mp) {
    void (async () => {
      try {
        const pending = await fetchMpReconnectPending();
        cleanupReconnectSuppressIfNoPending(pending);
        if (pending && shouldShowReconnectOverlay(pending)) {
          setMpButtonLabel(mp, "Reconnect");
          mp.setAttribute("aria-label", "Reconnect to your previous match");
        }
      } catch {
        /* ignore */
      }
    })();
  }

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
    void (async () => {
      const sessionOk = await validateSession();
      if (!sessionOk) return;
      const pending = await fetchMpReconnectPending();
      cleanupReconnectSuppressIfNoPending(pending);
      if (pending && shouldShowReconnectOverlay(pending)) {
        showMpReconnectMenuOverlay(pending, {
          onReconnect: () => {
            import("./mpResumeFromMenu.js").then((m) =>
              ctx.navigate(m.mountMpResumeFromMenuScreen, {
                mpReconnectPending: pending,
              }),
            );
          },
          onCancel: () => {
            ctx.navigate(mountModeSelectScreen);
          },
          onExpired: () => {
            import("./multiplayerHub.js").then((m) =>
              ctx.navigate(m.mountMultiplayerHubScreen),
            );
          },
        });
        return;
      }
      const paused = await fetchMpPauseStatus().catch(() => false);
      if (paused) {
        if (lockHint) {
          lockHint.textContent = MP_PAUSE_MESSAGE;
          lockHint.hidden = false;
        }
        return;
      }
      import("./multiplayerHub.js").then((m) =>
        ctx.navigate(m.mountMultiplayerHubScreen),
      );
    })();
  };

  const leadSpacer = root.querySelector("#mode-select-lead-spacer");

  const showModeChoice = () => {
    transitionPanelHeight(panel instanceof HTMLElement ? panel : null, () => {
      if (stepHome) stepHome.hidden = true;
      if (stepModes) stepModes.hidden = false;
      if (tagline) {
        tagline.classList.remove("mode-select-tagline--concealed");
        tagline.setAttribute("aria-hidden", "false");
      }
      if (backBtn) backBtn.hidden = false;
      if (leadSpacer) leadSpacer.hidden = true;
    });
  };

  const showHomeLanding = () => {
    transitionPanelHeight(panel instanceof HTMLElement ? panel : null, () => {
      if (stepHome) stepHome.hidden = false;
      if (stepModes) stepModes.hidden = true;
      if (tagline) {
        tagline.classList.add("mode-select-tagline--concealed");
        tagline.setAttribute("aria-hidden", "true");
      }
      if (backBtn) backBtn.hidden = true;
      if (leadSpacer) leadSpacer.hidden = false;
      if (lockHint) lockHint.hidden = true;
    });
  };

  playBtn?.addEventListener("click", () => {
    playSfxOn();
    showModeChoice();
  });

  backBtn?.addEventListener("click", () => {
    playSfxOff();
    showHomeLanding();
  });

  leaderboardBtn?.addEventListener("click", () => {
    playSfxMajor();
    import("./leaderboardScreen.js").then((m) =>
      ctx.navigate(m.mountLeaderboardScreen, {
        skipPanelEnterTransition: true,
      }),
    );
  });

  shopBtn?.addEventListener("click", () => {
    playSfxMinor();
    import("./shopScreen.js").then((m) => ctx.navigate(m.mountShopScreen));
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
