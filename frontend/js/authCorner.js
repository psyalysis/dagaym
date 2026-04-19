/**
 * Top-right account bubble — main.js wipes it on every screen change.
 */
import { clearAuthSession, fetchMe } from "./authApi.js";
import { rankBadgeHtml } from "./rankUi.js";
import { supporterDisplayNameInnerHtml } from "./supporters.js";
import { playSfxMajor, playSfxMinor, playSfxOff, playSfxOn } from "./sfx.js";

const AUTH_MENU_OPEN = "auth-corner-menu--open";
const BEATBUCKS_ICON_SRC = new URL(
  "../imgs/icons/beatbucks.png",
  import.meta.url,
).href;

/**
 * @param {HTMLElement} root — `.auth-corner-menu` wrapper
 */
function initAuthCornerAccountMenu(root) {
  const toggle = root.querySelector(".auth-corner-menu-toggle");
  const panel = root.querySelector("#auth-corner-menu-panel");
  if (!(toggle instanceof HTMLButtonElement) || !(panel instanceof HTMLElement))
    return;

  const setOpen = (open) => {
    if (root.classList.contains(AUTH_MENU_OPEN) === open) return;
    root.classList.toggle(AUTH_MENU_OPEN, open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    toggle.setAttribute(
      "aria-label",
      open ? "Close account actions" : "Open account actions",
    );
    if (open) panel.removeAttribute("inert");
    else panel.setAttribute("inert", "");
    if (open) playSfxOn();
    else playSfxOff();
  };

  toggle.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(!root.classList.contains(AUTH_MENU_OPEN));
  });

  document.addEventListener(
    "click",
    (ev) => {
      if (!root.classList.contains(AUTH_MENU_OPEN)) return;
      const t = ev.target;
      if (t instanceof Node && root.contains(t)) return;
      setOpen(false);
    },
    true,
  );

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && root.classList.contains(AUTH_MENU_OPEN)) {
      setOpen(false);
      toggle.focus();
    }
  });
}

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
 * Signed in: avatar-ish card + LB or Home + logout (or logout only when Leaderboard exists on-page).
 * @param {{ navigate: function }} ctx
 * @param {{ primary?: 'leaderboard' | 'home', logoutOnly?: boolean }} [opts]
 */
export function mountAuthCornerMenu(ctx, opts = {}) {
  const logoutOnly = Boolean(opts.logoutOnly);
  const primary = opts.primary ?? "leaderboard";
  const el = ensureCornerEl();
  const primaryLabel = primary === "home" ? "Home" : "Leaderboard";
  const primaryId = primary === "home" ? "auth-corner-home" : "auth-corner-lb";

  const actionsHtml = logoutOnly
    ? `<button type="button" class="auth-corner-btn" id="auth-corner-profile">Profile</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-out">Logout</button>`
    : `<button type="button" class="auth-corner-btn" id="auth-corner-profile">Profile</button>
        <button type="button" class="auth-corner-btn" id="${primaryId}">${primaryLabel}</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-out">Logout</button>`;

  el.innerHTML = `
    <div class="auth-corner-stack auth-corner-menu">
      <button type="button" class="auth-corner-card auth-corner-menu-toggle" id="auth-corner-menu-toggle" aria-expanded="false" aria-controls="auth-corner-menu-panel" aria-label="Open account actions">
        <div class="auth-corner-card-label">Signed in</div>
        <div class="auth-corner-name name-with-rank" id="auth-corner-name">…</div>
        <div class="auth-corner-wins" id="auth-corner-wins">—</div>
      </button>
      <div class="auth-corner-menu__grow" id="auth-corner-menu-panel" role="region" aria-labelledby="auth-corner-menu-toggle" aria-hidden="true" inert>
        <div class="auth-corner-menu__grow-inner">
          <div class="auth-corner-actions auth-corner-menu__inner">
            ${actionsHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  const nameEl = el.querySelector("#auth-corner-name");
  const winsEl = el.querySelector("#auth-corner-wins");
  if (nameEl) nameEl.textContent = ctx.username || "…";

  fetchMe()
    .then((me) => {
      if (nameEl) {
        nameEl.innerHTML = `${rankBadgeHtml(me.rank)}${supporterDisplayNameInnerHtml(me.username)}`;
      }
      if (winsEl) {
        winsEl.replaceChildren();
        winsEl.append(
          document.createTextNode(
            `${me.wins} ${me.wins === 1 ? "win" : "wins"} · ${me.coins ?? 0}`,
          ),
        );
        const icon = document.createElement("img");
        icon.src = BEATBUCKS_ICON_SRC;
        icon.alt = "";
        icon.className = "beatbucks-inline-icon";
        icon.setAttribute("aria-hidden", "true");
        winsEl.append(icon);
      }
    })
    .catch(() => {
      if (winsEl) winsEl.textContent = "";
    });

  el.querySelector("#auth-corner-profile")?.addEventListener("click", () => {
    playSfxMinor();
    const un = ctx.username || "";
    if (un) {
      history.pushState({ profile: un }, "", `/@${un}`);
    }
    import("./screens/profileScreen.js").then((m) =>
      ctx.navigate(m.mountProfileScreen, {
        profileUsername: un,
        skipPanelEnterTransition: true,
      }),
    );
  });

  if (!logoutOnly) {
    if (primary === "home") {
      el.querySelector("#auth-corner-home")?.addEventListener("click", () => {
        playSfxMinor();
        import("./screens/modeSelect.js").then((m) =>
          ctx.navigate(m.mountModeSelectScreen),
        );
      });
    } else {
      el.querySelector("#auth-corner-lb")?.addEventListener("click", () => {
        playSfxMajor();
        import("./screens/leaderboardScreen.js").then((m) =>
          ctx.navigate(m.mountLeaderboardScreen, {
            skipPanelEnterTransition: true,
          }),
        );
      });
    }
  }

  el.querySelector("#auth-corner-out")?.addEventListener("click", () => {
    playSfxMinor();
    clearAuthSession();
    import("./screens/modeSelect.js").then((m) =>
      ctx.navigate(m.mountModeSelectScreen),
    );
  });

  const menuRoot = el.querySelector(".auth-corner-menu");
  if (menuRoot instanceof HTMLElement) initAuthCornerAccountMenu(menuRoot);
}

/**
 * Guest: login + register; on leaderboard screen also Home (main menu has its own LB under Play).
 * @param {{ navigate: function }} ctx
 * @param {{ showHome?: boolean }} [opts] — true on leaderboard screen (Home → menu)
 */
export function mountAuthCornerGuest(ctx, opts = {}) {
  const showHome = Boolean(opts.showHome);
  const el = ensureCornerEl();

  const buttonsHtml = showHome
    ? `<button type="button" class="auth-corner-btn" id="auth-corner-home">Home</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-login">Login</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-reg">Register</button>`
    : `<button type="button" class="auth-corner-btn" id="auth-corner-login">Login</button>
        <button type="button" class="auth-corner-btn" id="auth-corner-reg">Register</button>`;

  el.innerHTML = `
    <div class="auth-corner-stack">
      <div class="auth-corner-actions auth-corner-actions--guest auth-corner-actions--wide">
        ${buttonsHtml}
      </div>
    </div>
  `;

  if (showHome) {
    el.querySelector("#auth-corner-home")?.addEventListener("click", () => {
      playSfxMinor();
      import("./screens/modeSelect.js").then((m) =>
        ctx.navigate(m.mountModeSelectScreen),
      );
    });
  }

  el.querySelector("#auth-corner-login")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/loginScreen.js").then((m) =>
      ctx.navigate(m.mountLoginScreen),
    );
  });
  el.querySelector("#auth-corner-reg")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/registerScreen.js").then((m) =>
      ctx.navigate(m.mountRegisterScreen),
    );
  });
}

/** On login: Home + Register shortcuts. */
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
    import("./screens/modeSelect.js").then((m) =>
      ctx.navigate(m.mountModeSelectScreen),
    );
  });
  el.querySelector("#auth-corner-reg")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/registerScreen.js").then((m) =>
      ctx.navigate(m.mountRegisterScreen),
    );
  });
}

/** On register: Home + Login shortcuts. */
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
    import("./screens/modeSelect.js").then((m) =>
      ctx.navigate(m.mountModeSelectScreen),
    );
  });
  el.querySelector("#auth-corner-login")?.addEventListener("click", () => {
    playSfxMinor();
    import("./screens/loginScreen.js").then((m) =>
      ctx.navigate(m.mountLoginScreen),
    );
  });
}

/** In a match: single Leave — screen unmount tears down WS/audio. */
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
    const ws = ctx.mpWs;
    if (ws instanceof WebSocket && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "leave_lobby" }));
      } catch {
        /* ignore */
      }
    }
    import("./screens/modeSelect.js").then((m) =>
      ctx.navigate(m.mountModeSelectScreen),
    );
  });
}
