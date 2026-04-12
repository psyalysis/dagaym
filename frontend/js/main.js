/**
 * Beat Battle — screen router and shared context.
 */
import { getApiBase } from "./apiOrigin.js";
import { clearAuthCorner } from "./authCorner.js";
import { getUsername, isLoggedIn, validateSession } from "./authApi.js";
import { showAppError } from "./errorToast.js";
import { playSfxBeatBattle } from "./sfx.js";
import { mountModeSelectScreen } from "./screens/modeSelect.js";
import { initCornerSocialTooltips } from "./cornerSocialTooltips.js";
import { initDevStatsPanel, recordPageVisit } from "./devStatsPanel.js";

function boot() {
  recordPageVisit();
  initCornerSocialTooltips();
  window.addEventListener("error", (ev) => {
    const fn = ev.filename || "";
    if (!fn || fn.includes("extension://") || fn.includes("moz-extension://")) return;
    if (!fn.includes("/js/") && !fn.endsWith("main.js")) return;
    showAppError({
      message: ev.message || "A script error occurred.",
      errorCode: ev.lineno ? `SCRIPT_L${ev.lineno}` : "SCRIPT",
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    const msg = r instanceof Error ? r.message : String(r);
    showAppError({
      message: msg || "Unhandled promise rejection.",
      errorCode: "UNHANDLED_REJECTION",
    });
  });

  playSfxBeatBattle();

  const root = document.getElementById("app-root");
  if (!root) return;

  let unmount = null;

  /** @param {(el: HTMLElement, ctx: object) => () => void} mountFn */
  const navigate = (mountFn, extra = {}) => {
    if (unmount) unmount();
    clearAuthCorner();
    const ctx = {
      apiBase: getApiBase(),
      navigate,
      username: getUsername(),
      ...extra,
    };
    unmount = mountFn(root, ctx);
  };

  navigate(mountModeSelectScreen);

  if (isLoggedIn()) {
    void validateSession().then((ok) => {
      if (!ok) navigate(mountModeSelectScreen);
      else initDevStatsPanel();
    });
  }
}

document.addEventListener("DOMContentLoaded", boot);
