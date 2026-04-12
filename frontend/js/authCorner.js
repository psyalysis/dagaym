/**
 * Fixed top-right account card + auth actions (cleared on each navigate from main.js).
 */
import { clearAuthSession, fetchMe } from "./authApi.js";
import { rankBadgeHtml } from "./rankUi.js";
import { supporterDisplayNameInnerHtml } from "./supporters.js";
import { playSfxMajor, playSfxMinor } from "./sfx.js";

function ensureCornerEl() {
  let el = document.getElementById("auth-corner");
  if (!el) {
    el = document.createElement("div");
    el.id = "auth-corner";
    el.className = "auth-corner";
    el.setAttribute("aria-label", "Account");
    document.body.appendChild(el);
  }
  el.hidden = false;
  return el;
}

export function clearAuthCorner() {
  const el = document.getElementById("auth-corner");
  if (el) {
    el.innerHTML = "";
    el.hidden = true;
  }
}

/**
 * Logged-in menu: profile card + Leaderboard or Home + Logout.
 * @param {{ navigate: function }} ctx
 * @param {{ primary?: 'leaderboard' | 'home' }} [opts]
 */
export function mountAuthCornerMenu(ctx, opts = {}) {
  const primary = opts.primary ?? "leaderboard";
  const el = ensureCornerEl();
  const primaryLabel = primary === "home" ? "Home" : "Leaderboard";
  const primaryId = primary === "home" ? "auth-corner-home" : "auth-corner-lb";

  el.innerHTML = `
    <div class="auth-corner-stack">
      <div class="auth-corner-card">
        <div class="auth-corner-card-label">Signed in</div>
        <div class="auth-corner-name" id="auth-corner-name">…</div>
        <div class="auth-corner-wins" id="auth-corner-wins">—</div>
      </div>
      <div class="auth-corner-actions">
        <button type="button" class="auth-corner-btn" id="${primaryId}">${primaryLabel}</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-out">Logout</button>
      </div>
    </div>
  `;

  const nameEl = el.querySelector("#auth-corner-name");
  const winsEl = el.querySelector("#auth-corner-wins");
  if (nameEl) nameEl.textContent = ctx.username || "…";

  fetchMe()
    .then((me) => {
      if (nameEl) {
        nameEl.innerHTML = `${supporterDisplayNameInnerHtml(me.username)}${rankBadgeHtml(me.rank)}`;
      }
      if (winsEl) winsEl.textContent = `${me.wins} ${me.wins === 1 ? "win" : "wins"}`;
    })
    .catch(() => {
      if (winsEl) winsEl.textContent = "";
    });

  if (primary === "home") {
    el.querySelector("#auth-corner-home")?.addEventListener("click", () => {
      playSfxMinor();
      import("./screens/modeSelect.js").then((m) => ctx.navigate(m.mountModeSelectScreen));
    });
  } else {
    el.querySelector("#auth-corner-lb")?.addEventListener("click", () => {
      playSfxMajor();
      import("./screens/leaderboardScreen.js").then((m) => ctx.navigate(m.mountLeaderboardScreen));
    });
  }

  el.querySelector("#auth-corner-out")?.addEventListener("click", () => {
    playSfxMinor();
    clearAuthSession();
    import("./screens/modeSelect.js").then((m) => ctx.navigate(m.mountModeSelectScreen));
  });
}

/**
 * Not logged in: compact actions (Leaderboard / Home + Login + Register).
 * @param {{ navigate: function }} ctx
 * @param {{ showHome?: boolean }} [opts] — true on leaderboard screen (Home → menu)
 */
export function mountAuthCornerGuest(ctx, opts = {}) {
  const showHome = Boolean(opts.showHome);
  const el = ensureCornerEl();
  const primaryId = showHome ? "auth-corner-home" : "auth-corner-lb";
  const primaryLabel = showHome ? "Home" : "Leaderboard";

  el.innerHTML = `
    <div class="auth-corner-stack">
      <div class="auth-corner-actions auth-corner-actions--guest auth-corner-actions--wide">
        <button type="button" class="auth-corner-btn" id="${primaryId}">${primaryLabel}</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-login">Login</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-reg">Register</button>
      </div>
    </div>
  `;

  if (showHome) {
    el.querySelector("#auth-corner-home")?.addEventListener("click", () => {
      playSfxMinor();
      import("./screens/modeSelect.js").then((m) => ctx.navigate(m.mountModeSelectScreen));
    });
  } else {
    el.querySelector("#auth-corner-lb")?.addEventListener("click", () => {
      playSfxMajor();
      import("./screens/leaderboardScreen.js").then((m) => ctx.navigate(m.mountLeaderboardScreen));
    });
  }

  el.querySelector("#auth-corner-login")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/loginScreen.js").then((m) => ctx.navigate(m.mountLoginScreen));
  });
  el.querySelector("#auth-corner-reg")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/registerScreen.js").then((m) => ctx.navigate(m.mountRegisterScreen));
  });
}

/** Login screen: Home + Register in corner. */
export function mountAuthCornerLoginGuest(ctx) {
  const el = ensureCornerEl();
  el.innerHTML = `
    <div class="auth-corner-stack">
      <div class="auth-corner-actions auth-corner-actions--guest auth-corner-actions--wide">
        <button type="button" class="auth-corner-btn" id="auth-corner-home">Home</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-reg">Register</button>
      </div>
    </div>
  `;
  el.querySelector("#auth-corner-home")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/modeSelect.js").then((m) => ctx.navigate(m.mountModeSelectScreen));
  });
  el.querySelector("#auth-corner-reg")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/registerScreen.js").then((m) => ctx.navigate(m.mountRegisterScreen));
  });
}

/** Register screen: Home + Login in corner. */
export function mountAuthCornerRegisterGuest(ctx) {
  const el = ensureCornerEl();
  el.innerHTML = `
    <div class="auth-corner-stack">
      <div class="auth-corner-actions auth-corner-actions--guest auth-corner-actions--wide">
        <button type="button" class="auth-corner-btn" id="auth-corner-home">Home</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-login">Login</button>
      </div>
    </div>
  `;
  el.querySelector("#auth-corner-home")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/modeSelect.js").then((m) => ctx.navigate(m.mountModeSelectScreen));
  });
  el.querySelector("#auth-corner-login")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/loginScreen.js").then((m) => ctx.navigate(m.mountLoginScreen));
  });
}

/** In-game: Leave → main menu (unmount cleans WebSocket / audio). */
export function mountAuthCornerLeave(ctx) {
  const el = ensureCornerEl();
  el.innerHTML = `
    <div class="auth-corner-stack">
      <div class="auth-corner-actions auth-corner-actions--guest">
        <button type="button" class="auth-corner-btn auth-corner-btn--leave" id="auth-corner-leave">Leave</button>
      </div>
    </div>
  `;
  el.querySelector("#auth-corner-leave")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/modeSelect.js").then((m) => ctx.navigate(m.mountModeSelectScreen));
  });
}
