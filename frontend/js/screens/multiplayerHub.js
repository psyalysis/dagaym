/**
 * Multiplayer hub — create, browse, or join by code.
 */
import { getUsername, isLoggedIn, validateSession } from "../authApi.js";
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

  let cancelled = false;
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

    root.innerHTML = `
    <div class="screen mp-hub arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="mp-hub-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">MULTIPLAYER</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <div class="mp-hub-body">
        <p class="arcade-hint">Playing as <strong>${nameHtml}</strong></p>
        <div class="mp-hub-actions">
          <button type="button" class="arcade-btn arcade-btn-primary" id="mp-create">Create game</button>
          <button type="button" class="arcade-btn arcade-btn-primary" id="mp-join-code">Join game</button>
          <button type="button" class="arcade-btn arcade-btn-secondary" id="mp-browse">Browse servers</button>
        </div>
      </div>
    </div>
  `;

    root.querySelector("#mp-hub-back")?.addEventListener("click", () => {
      playSfxMinor();
      ctx.navigate(mountModeSelectScreen);
    });

    root.querySelector("#mp-create")?.addEventListener("click", () => {
      playSfxMajor();
      ctx.navigate(mountSpiceSelectScreen, { mpName: displayName, username: displayName });
    });
    root.querySelector("#mp-browse")?.addEventListener("click", () => {
      playSfxMajor();
      ctx.navigate(mountServerBrowserScreen, { mpName: displayName, username: displayName });
    });
    root.querySelector("#mp-join-code")?.addEventListener("click", () => {
      playSfxMajor();
      ctx.navigate(mountJoinCodeScreen, { mpName: displayName, username: displayName });
    });
  })();

  return () => {
    cancelled = true;
    root.innerHTML = "";
  };
}
