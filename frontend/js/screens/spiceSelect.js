/**
 * Pick your heat + public or code-only, then we spin up a lobby.
 */
import { getUsername } from "../authApi.js";
import { setAppErrorContext } from "../errorToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { playSfxMajor, playSfxMinor, playSfxOff, playSfxOn } from "../sfx.js";
import { mountMatchmakingScreen } from "./matchmaking.js";
const CHILI_SRC = new URL("../../imgs/chili.png", import.meta.url).href;

const SPICES = [
  { value: 0.25, count: 1 },
  { value: 0.5, count: 2 },
  { value: 0.85, count: 3 },
];

export function mountSpiceSelectScreen(root, ctx) {
  const displayName = (ctx.username || ctx.mpName || getUsername() || "Player").trim();

  setAppErrorContext({ screen: "Heat level", phase: "Before creating lobby" });
  mountAuthCornerLeave(ctx);

  root.innerHTML = `
    <div class="screen spice-select arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="spice-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">HEAT LEVEL</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <div class="mp-hub-body">
      <p class="arcade-hint spice-toggle-hint">Choose heat for this lobby</p>
      <fieldset class="visibility-field">
        <legend class="arcade-label">Lobby visibility</legend>
        <label class="vis-option"><input type="radio" name="lobby-vis" value="public" checked /> Public — listed in server browser</label>
        <label class="vis-option"><input type="radio" name="lobby-vis" value="private" /> Code only — friends join with the code</label>
      </fieldset>
      <div class="spice-cards" id="spice-cards"></div>
      <button type="button" class="arcade-btn arcade-btn-primary" id="spice-confirm" disabled>Create lobby</button>
      </div>
    </div>
  `;

  const cardsEl = root.querySelector("#spice-cards");
  /** @type {Set<number>} */
  const selected = new Set(SPICES.map((x) => x.value));

  SPICES.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "spice-card spice-card--active";
    b.dataset.spice = String(s.value);
    b.setAttribute("aria-pressed", "true");
    const row = document.createElement("span");
    row.className = "spice-card-chilis";
    row.setAttribute("aria-hidden", "true");
    for (let i = 0; i < s.count; i++) {
      const img = document.createElement("img");
      img.className = "spice-chili-icon";
      img.src = CHILI_SRC;
      img.alt = "";
      img.width = 32;
      img.height = 32;
      row.appendChild(img);
    }
    b.appendChild(row);
    b.addEventListener("click", () => {
      const on = selected.has(s.value);
      if (on) {
        if (selected.size <= 1) return;
        playSfxOff();
        selected.delete(s.value);
        b.classList.remove("spice-card--active");
        b.setAttribute("aria-pressed", "false");
      } else {
        playSfxOn();
        selected.add(s.value);
        b.classList.add("spice-card--active");
        b.setAttribute("aria-pressed", "true");
      }
      updateConfirm();
    });
    cardsEl?.appendChild(b);
  });

  const confirm = root.querySelector("#spice-confirm");
  const updateConfirm = () => {
    if (confirm) confirm.disabled = selected.size === 0;
  };

  root.querySelector("#spice-back")?.addEventListener("click", () => {
    playSfxMinor();
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
  });

  confirm?.addEventListener("click", () => {
    playSfxMajor();
    const vis = root.querySelector('input[name="lobby-vis"]:checked');
    const isPublic = vis?.getAttribute("value") !== "private";
    ctx.navigate(mountMatchmakingScreen, {
      mpName: displayName,
      username: displayName,
      lobbyFlow: "create",
      isPublic,
      mpSpices: Array.from(selected).sort((a, b) => a - b),
    });
  });

  updateConfirm();

  return () => {
    root.innerHTML = "";
  };
}
