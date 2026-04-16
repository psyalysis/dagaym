/**
 * Wins leaderboard — sorted, that's it.
 */
import { fetchLeaderboard, isLoggedIn } from "../authApi.js";
import { setAppErrorContext } from "../errorToast.js";
import { escapeHtml, rankBadgeHtml } from "../rankUi.js";
import { supporterDisplayNameInnerHtml } from "../supporters.js";
import { mountAuthCornerGuest, mountAuthCornerMenu } from "../authCorner.js";
import { playSfxMinor } from "../sfx.js";
import { mountModeSelectScreen } from "./modeSelect.js";

export function mountLeaderboardScreen(root, ctx) {
  setAppErrorContext({ screen: "Leaderboard", phase: "Wins list" });
  root.innerHTML = `
    <div class="screen leaderboard-screen arcade-panel screen--vert-center">
      <div class="screen-topbar">
        <button type="button" class="arcade-back" id="lb-back" aria-label="Back">&lt;</button>
        <h2 class="arcade-heading screen-topbar-title">LEADERBOARD</h2>
        <span class="screen-topbar-spacer" aria-hidden="true"></span>
      </div>
      <p class="arcade-status" id="lb-status">Loading…</p>
      <div class="leaderboard-table-wrap" id="lb-table"></div>
    </div>
  `;

  const statusEl = root.querySelector("#lb-status");
  const tableWrap = root.querySelector("#lb-table");

  if (isLoggedIn()) {
    mountAuthCornerMenu(ctx, { primary: "home" });
  } else {
    mountAuthCornerGuest(ctx, { showHome: true });
  }

  root.querySelector("#lb-back")?.addEventListener("click", () => {
    playSfxMinor();
    ctx.navigate(mountModeSelectScreen);
  });

  fetchLeaderboard()
    .then((rows) => {
      if (statusEl) statusEl.textContent = "";
      if (!Array.isArray(rows) || rows.length === 0) {
        if (tableWrap) tableWrap.innerHTML = `<p class="arcade-hint">No players yet.</p>`;
        return;
      }
      const head = `
        <div class="lb-row lb-row-head">
          <span>RANK</span><span>PLAYER</span><span>WINS</span>
        </div>`;
      const body = rows
        .map(
          (r, i) => `
        <div class="lb-row">
          <span>${i + 1}</span>
          <span class="lb-player name-with-rank">${rankBadgeHtml(r.rank)}${supporterDisplayNameInnerHtml(r.username)}</span>
          <span>${escapeHtml(String(r.wins))}</span>
        </div>`,
        )
        .join("");
      if (tableWrap) tableWrap.innerHTML = `<div class="leaderboard-table">${head}${body}</div>`;
    })
    .catch((e) => {
      if (statusEl) statusEl.textContent = e instanceof Error ? e.message : "Could not load.";
    });

  return () => {
    root.innerHTML = "";
  };
}
