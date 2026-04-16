/**
 * MP home: host a game, browse the list, or type a code.
 */
import { getUsername, isLoggedIn, validateSession } from "../authApi.js";
import {
  cleanupReconnectSuppressIfNoPending,
  fetchMpReconnectPending,
  getReconnectSuppressState,
  isHubBlockedByReconnectDismiss,
} from "../mpReconnectPending.js";
import { setAppErrorContext } from "../errorToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountModeSelectScreen } from "./modeSelect.js";
import { mountJoinCodeScreen } from "./joinCode.js";
import { mountServerBrowserScreen } from "./serverBrowser.js";
import { mountSpiceSelectScreen } from "./spiceSelect.js";
import { supporterDisplayNameInnerHtml } from "../supporters.js";

export function mountMultiplayerHubScreen(root, ctx) {
  if (!isLoggedIn()) {
    root.innerHTML = "";
    queueMicrotask(() => ctx.navigate(mountModeSelectScreen));
    return () => {};
  }

  setAppErrorContext({ screen: "Multiplayer menu", phase: "Hub" });
  let cancelled = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let hubBlockPollId = null;
  mountAuthCornerLeave(ctx);
  root.innerHTML = `
    <div class="screen mp-hub arcade-panel screen--vert-center">
      <p class="arcade-status" id="mp-hub-status">Checking session…</p>
    </div>
  `;

  void (async () => {
    const ok = await validateSession();
    if (cancelled) return;
    if (!ok) {
      ctx.navigate(mountModeSelectScreen);
      return;
    }

    const displayName = ctx.username || getUsername() || "Player";
    const nameHtml = supporterDisplayNameInnerHtml(displayName);

    const pending = await fetchMpReconnectPending();
    cleanupReconnectSuppressIfNoPending(pending);
    const hubBlocked = isHubBlockedByReconnectDismiss(pending);
    const blockHint = hubBlocked
      ? `<p class="arcade-hint mp-hub-reconnect-block-hint" id="mp-hub-reconnect-hint">You can start a new game when the reconnect window ends.</p>`
      : "";

    root.innerHTML = `
    <div class="screen mp-hub arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="mp-hub-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">MULTIPLAYER</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <div class="mp-hub-body">
        <p class="arcade-hint">Playing as <strong>${nameHtml}</strong></p>
        ${blockHint}
        <div class="mp-hub-actions${hubBlocked ? " mp-hub-actions--blocked" : ""}">
          <button type="button" class="arcade-btn arcade-btn-primary" id="mp-create"${
            hubBlocked ? " disabled" : ""
          }>Create game</button>
          <button type="button" class="arcade-btn arcade-btn-primary" id="mp-join-code"${
            hubBlocked ? " disabled" : ""
          }>Join game</button>
          <button type="button" class="arcade-btn arcade-btn-secondary" id="mp-browse"${
            hubBlocked ? " disabled" : ""
          }>Browse servers</button>
        </div>
      </div>
    </div>
  `;

    root.querySelector("#mp-hub-back")?.addEventListener("click", () => {
      playSfxMinor();
      ctx.navigate(mountModeSelectScreen);
    });

    root.querySelector("#mp-create")?.addEventListener("click", () => {
      if (hubBlocked) return;
      playSfxMajor();
      ctx.navigate(mountSpiceSelectScreen, { mpName: displayName, username: displayName });
    });
    root.querySelector("#mp-browse")?.addEventListener("click", () => {
      if (hubBlocked) return;
      playSfxMajor();
      ctx.navigate(mountServerBrowserScreen, { mpName: displayName, username: displayName });
    });
    root.querySelector("#mp-join-code")?.addEventListener("click", () => {
      if (hubBlocked) return;
      playSfxMajor();
      ctx.navigate(mountJoinCodeScreen, { mpName: displayName, username: displayName });
    });

    if (hubBlocked) {
      const st = getReconnectSuppressState();
      const until = st?.untilMs ?? 0;
      hubBlockPollId = window.setInterval(() => {
        if (cancelled) {
          if (hubBlockPollId != null) window.clearInterval(hubBlockPollId);
          return;
        }
        if (Date.now() >= until) {
          if (hubBlockPollId != null) window.clearInterval(hubBlockPollId);
          hubBlockPollId = null;
          ctx.navigate(mountMultiplayerHubScreen);
        }
      }, 500);
    }
  })();

  return () => {
    cancelled = true;
    if (hubBlockPollId != null) window.clearInterval(hubBlockPollId);
    root.innerHTML = "";
  };
}
