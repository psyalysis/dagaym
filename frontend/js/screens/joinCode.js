/**
 * Join a lobby by typing its code (public or private).
 */
import { getUsername } from "../authApi.js";
import { setAppErrorContext } from "../errorToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountMatchmakingScreen } from "./matchmaking.js";

export function mountJoinCodeScreen(root, ctx) {
  const displayName = (ctx.username || ctx.mpName || getUsername() || "Player").trim();

  setAppErrorContext({ screen: "Join by code", phase: "Enter lobby code" });
  mountAuthCornerLeave(ctx);

  root.innerHTML = `
    <div class="screen join-code arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="jc-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">JOIN GAME</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <div class="mp-hub-body">
      <label class="arcade-label">Lobby code</label>
      <input type="text" id="jc-code" class="arcade-input arcade-input--center lobby-code-input" maxlength="16" placeholder="e.g. B865E1" autocomplete="off" />
      <button type="button" class="arcade-btn arcade-btn-primary" id="jc-go">Join lobby</button>
      </div>
    </div>
  `;

  root.querySelector("#jc-back")?.addEventListener("click", () => {
    playSfxMinor();
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
  });

  root.querySelector("#jc-go")?.addEventListener("click", () => {
    const raw = (root.querySelector("#jc-code")?.value || "").trim();
    const code = raw
      ? raw.toUpperCase().replace(/\s+/g, "").replace(/[-_]/g, "")
      : "";
    if (!code) return;
    playSfxMajor();
    ctx.navigate(mountMatchmakingScreen, {
      mpName: displayName,
      username: displayName,
      lobbyFlow: "join_code",
      lobbyCode: code,
    });
  });

  return () => {
    root.innerHTML = "";
  };
}
