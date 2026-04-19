/**
 * New account — then you still have to log in after.
 */
import { registerUser } from "../authApi.js";
import { setAppErrorContext } from "../errorToast.js";
import { mountAuthCornerRegisterGuest } from "../authCorner.js";
import { playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountLoginScreen } from "./loginScreen.js";

const USER_RE = /^[a-z0-9_]{3,20}$/;

export function mountRegisterScreen(root, ctx) {
  setAppErrorContext({ screen: "Register", phase: "New account" });
  root.innerHTML = `
    <div class="screen register-screen arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="reg-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">REGISTER</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <div class="mp-hub-body">
        <p class="arcade-hint">3–20 characters: lowercase letters, numbers, underscores</p>
        <label class="arcade-label" for="reg-user">Username</label>
        <input type="text" id="reg-user" class="arcade-input arcade-input--center" maxlength="20" autocomplete="username" />
        <label class="arcade-label" for="reg-pass">Password</label>
        <input type="password" id="reg-pass" class="arcade-input arcade-input--center" maxlength="128" autocomplete="new-password" />
        <p class="arcade-error" id="reg-err"></p>
        <div class="arcade-actions">
          <button type="button" class="arcade-btn arcade-btn-primary" id="reg-go">Register</button>
        </div>
      </div>
    </div>
  `;

  const errEl = () => root.querySelector("#reg-err");

  mountAuthCornerRegisterGuest(ctx);

  root.querySelector("#reg-back")?.addEventListener("click", () => {
    playSfxMinor();
    ctx.navigate(mountLoginScreen);
  });

  root.querySelector("#reg-go")?.addEventListener("click", async () => {
    const u = (root.querySelector("#reg-user")?.value || "").trim();
    const p = root.querySelector("#reg-pass")?.value || "";
    const err = errEl();
    if (err) err.textContent = "";
    if (!USER_RE.test(u)) {
      if (err)
        err.textContent =
          "Username: 3–20 chars, lowercase letters, numbers, underscores only.";
      return;
    }
    if (!p) {
      if (err) err.textContent = "Enter a password.";
      return;
    }
    playSfxMajor();
    try {
      await registerUser(u, p);
      ctx.navigate(mountLoginScreen);
    } catch (e) {
      if (err) {
        const msg =
          typeof e === "string"
            ? e
            : e?.message || e?.detail || "Registration failed.";
        err.textContent = typeof msg === "string" ? msg : String(msg);
      }
    }
  });

  return () => {
    root.innerHTML = "";
  };
}
