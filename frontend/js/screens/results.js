/**
 * ResultsScreen — winner and leaderboard.
 */
import { fetchMe } from "../authApi.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { RANK_BASELINE_KEY, RANK_PENDING_KEY } from "../rankUi.js";
import { playSfxMinor } from "../sfx.js";

export function mountResultsScreen(root, ctx) {
  mountAuthCornerLeave(ctx);

  const wsSock = ctx.mpWs;
  const r = ctx.results || {};
  const winners = r.winners || [];
  const board = r.leaderboard || [];

  const winnerBlock =
    winners.length > 0
      ? `<div class="results-winner">WINNER<br/><span class="results-winner-name">${escapeHtml(
          winners.join(" · "),
        )}</span></div>`
      : `<p class="arcade-hint">No winner this round.</p>`;

  const rows = board
    .map(
      (row, i) => `
    <div class="results-row">
      <span class="results-rank">${i + 1}.</span>
      <span class="results-name">${escapeHtml(row.name)}</span>
      <span class="results-votes">${row.votes}</span>
    </div>
  `,
    )
    .join("");

  root.innerHTML = `
    <div class="screen results arcade-panel">
      <h2 class="arcade-heading">RESULTS</h2>
      ${winnerBlock}
      <div class="results-board">${rows}</div>
      <button type="button" class="arcade-btn arcade-btn-primary" id="results-home">Main menu</button>
    </div>
  `;

  root.querySelector("#results-home")?.addEventListener("click", async () => {
    playSfxMinor();
    try {
      wsSock.close();
    } catch {
      /* ignore */
    }
    const before = Number(sessionStorage.getItem(RANK_BASELINE_KEY) || "0");
    try {
      const me = await fetchMe();
      const after = Number(me.rank_index ?? 0);
      if (after > before && me.rank) {
        sessionStorage.setItem(
          RANK_PENDING_KEY,
          JSON.stringify({
            label: me.rank.label,
            abbrev: me.rank.abbrev,
            color: me.rank.color,
          }),
        );
      }
    } catch {
      /* ignore */
    }
    sessionStorage.removeItem(RANK_BASELINE_KEY);
    import("./modeSelect.js").then((m) => ctx.navigate(m.mountModeSelectScreen));
  });

  return () => {
    root.innerHTML = "";
    try {
      wsSock.close();
    } catch {
      /* ignore */
    }
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
