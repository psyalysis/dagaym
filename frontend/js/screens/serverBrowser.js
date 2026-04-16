/**
 * Open games from /api/lobbies — tap one to join by id.
 */
import { getUsername } from "../authApi.js";
import { setAppErrorContext } from "../errorToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { getApiBase } from "../apiOrigin.js";
import { playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountMatchmakingScreen } from "./matchmaking.js";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mountServerBrowserScreen(root, ctx) {
  const name = (ctx.username || ctx.mpName || getUsername() || "Player").trim();
  let pollId = 0;

  setAppErrorContext({ screen: "Server browser", phase: "Public lobbies list" });
  mountAuthCornerLeave(ctx);

  root.innerHTML = `
    <div class="screen server-browser arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="sb-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">SERVERS</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <p class="arcade-hint">Public lobbies only — private games need a code</p>
      <p class="arcade-status" id="sb-status"></p>
      <div class="server-table-wrap" id="sb-table"></div>
    </div>
  `;

  const tableEl = root.querySelector("#sb-table");
  const statusEl = root.querySelector("#sb-status");

  const load = async () => {
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/lobbies`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()} (${base})`);
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        if (tableEl) {
          tableEl.innerHTML = `<p class="arcade-hint">No public lobbies right now. Create one or join with a code.</p>`;
        }
        if (statusEl) statusEl.textContent = "";
        return;
      }
      const header = `
        <div class="server-row server-row-head">
          <span>Code</span><span>Heat</span><span>Players</span><span></span>
        </div>`;
      const body = rows
        .map(
          (r) => `
        <div class="server-row" data-lid="${escapeHtml(r.lobby_id)}">
          <span class="server-code">${escapeHtml(r.lobby_id)}</span>
          <span>${escapeHtml(String(r.spice))}</span>
          <span>${r.player_count}/${r.max_players}</span>
          <button type="button" class="arcade-btn arcade-btn-primary server-join-btn">Join</button>
        </div>
      `,
        )
        .join("");
      if (tableEl) tableEl.innerHTML = `<div class="server-table">${header}${body}</div>`;
      tableEl?.querySelectorAll(".server-join-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const el = /** @type {HTMLElement} */ (e.currentTarget);
          const row = el.closest("[data-lid]");
          const lid = row?.getAttribute("data-lid");
          if (!lid) return;
          playSfxMajor();
          ctx.navigate(mountMatchmakingScreen, {
            mpName: name,
            username: name,
            lobbyFlow: "join_id",
            joinLobbyId: lid,
          });
        });
      });
      if (statusEl) statusEl.textContent = "Updated";
    } catch (e) {
      if (statusEl)
        statusEl.textContent = e instanceof Error ? e.message : "Could not load list";
    }
  };

  load();
  pollId = window.setInterval(load, 4000);

  root.querySelector("#sb-back")?.addEventListener("click", () => {
    playSfxMinor();
    import("./multiplayerHub.js").then((m) => ctx.navigate(m.mountMultiplayerHubScreen));
  });

  return () => {
    clearInterval(pollId);
    root.innerHTML = "";
  };
}
