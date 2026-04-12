/**
 * Login — username + password; JWT stored in localStorage.
 */
import { loginUser } from "../authApi.js";
import { mountAuthCornerLoginGuest } from "../authCorner.js";
import { initDevStatsPanel } from "../devStatsPanel.js";
import { playSfxMajor } from "../sfx.js";
import { mountModeSelectScreen } from "./modeSelect.js";

export function mountLoginScreen(root, ctx) {
  root.innerHTML = `
    <div class="screen login-screen arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
        <h2 class="arcade-heading screen-topbar-title">LOGIN</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <div class="mp-hub-body">
        <label class="arcade-label" for="login-user">Username</label>
        <input type="text" id="login-user" class="arcade-input arcade-input--center" maxlength="20" autocomplete="username" />
        <label class="arcade-label" for="login-pass">Password</label>
        <input type="password" id="login-pass" class="arcade-input arcade-input--center" maxlength="128" autocomplete="current-password" />
        <p class="arcade-error" id="login-err"></p>
        <div class="arcade-actions">
          <button type="button" class="arcade-btn arcade-btn-primary" id="login-go">Login</button>
        </div>
      </div>
    </div>
  `;

  const errEl = () => root.querySelector("#login-err");

  mountAuthCornerLoginGuest(ctx);

  root.querySelector("#login-go")?.addEventListener("click", async () => {
    const u = (root.querySelector("#login-user")?.value || "").trim();
    const p = root.querySelector("#login-pass")?.value || "";
    const err = errEl();
    if (err) err.textContent = "";
    if (!u || !p) {
      if (err) err.textContent = "Enter username and password.";
      return;
    }
    playSfxMajor();
    try {
      await loginUser(u, p);
      initDevStatsPanel();
      ctx.navigate(mountModeSelectScreen);
    } catch (e) {
      if (err) err.textContent = e instanceof Error ? e.message : "Login failed.";
    }
  });

  return () => {
    root.innerHTML = "";
  };
}
