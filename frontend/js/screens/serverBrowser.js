/**
 * Open games from /api/lobbies — tap one to join by id.
 */
import { getUsername } from "../authApi.js";
import { setAppErrorContext } from "../errorToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { getApiBase } from "../apiOrigin.js";
import { fetchPublicLobbyJoinable } from "../publicLobbyApi.js";
import { showAppError } from "../errorToast.js";
import { playSfxMajor, playSfxMinor } from "../sfx.js";
import { mountMatchmakingScreen } from "./matchmaking.js";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Drop rows that are not actually joinable (stale cache, race, or bad payload). */
function rowIsJoinable(/** @type {Record<string, unknown>} */ r) {
  const st = r.state != null ? String(r.state) : "lobby";
  if (st !== "lobby") return false;
  const max = Number(r.max_players) || 12;
  const pc = Number(r.player_count);
  const slots = r.slots_remaining;
  if (Number.isFinite(Number(slots))) return Number(slots) > 0;
  if (Number.isFinite(pc) && Number.isFinite(max)) return pc < max;
  return true;
}

export function mountServerBrowserScreen(root, ctx) {
  const name = (ctx.username || ctx.mpName || getUsername() || "Player").trim();
  let pollId = 0;
  /** Cancels any in-flight list fetch so an older response cannot overwrite a newer one. */
  let listFetchAbort = /** @type {AbortController | null} */ (null);

  setAppErrorContext({
    screen: "Server browser",
    phase: "Public lobbies list",
  });
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
    if (listFetchAbort) listFetchAbort.abort();
    listFetchAbort = new AbortController();
    const signal = listFetchAbort.signal;
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/lobbies`, {
        cache: "no-store",
        signal,
      });
      if (!res.ok)
        throw new Error(`${res.status} ${await res.text()} (${base})`);
      const rawRows = await res.json();
      const rows = Array.isArray(rawRows)
        ? rawRows.filter((r) => rowIsJoinable(/** @type {Record<string, unknown>} */ (r)))
        : [];
      if (rows.length === 0) {
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
      if (tableEl)
        tableEl.innerHTML = `<div class="server-table">${header}${body}</div>`;
      tableEl?.querySelectorAll(".server-join-btn").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          const el = /** @type {HTMLElement} */ (e.currentTarget);
          const row = el.closest("[data-lid]");
          const lid = row?.getAttribute("data-lid");
          if (!lid) return;
          el.setAttribute("disabled", "true");
          const ok = await fetchPublicLobbyJoinable(lid);
          el.removeAttribute("disabled");
          if (!ok) {
            if (statusEl) statusEl.textContent = "That lobby is gone or already started — refreshing";
            showAppError({
              message:
                "That lobby is no longer open. The list will refresh — try another or wait for a new game.",
              hint: "Games can start between refreshes; this is normal.",
              errorCode: "SB_STALE_LOBBY",
              source: "client",
            });
            await load();
            return;
          }
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
      if (e && typeof e === "object" && e.name === "AbortError") return;
      if (statusEl)
        statusEl.textContent =
          e instanceof Error ? e.message : "Could not load list";
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") void load();
  };
  const onPageShow = (/** @type {PageTransitionEvent} */ e) => {
    if (e.persisted) void load();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);

  load();
  pollId = window.setInterval(load, 1500);

  root.querySelector("#sb-back")?.addEventListener("click", () => {
    playSfxMinor();
    import("./multiplayerHub.js").then((m) =>
      ctx.navigate(m.mountMultiplayerHubScreen),
    );
  });

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    clearInterval(pollId);
    if (listFetchAbort) listFetchAbort.abort();
    root.innerHTML = "";
  };
}
