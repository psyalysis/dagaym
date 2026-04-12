/**
 * ResultsScreen — winner, beat cards sorted by votes (grid of waveforms).
 */
import { authHeadersMultipart, fetchMe } from "../authApi.js";
import { getApiBase } from "../apiOrigin.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { RANK_BASELINE_KEY, RANK_PENDING_KEY } from "../rankUi.js";
import { showServerRestartingWait } from "../serverRestartOverlay.js";
import { ingestMpChatMessage, mountMpChat, mpChatHandleErrorPayload } from "../mpChat.js";
import { notifyRematchWant } from "../mpPresenceToast.js";
import { playSfxMinor } from "../sfx.js";
import { supporterDisplayNameInnerHtml } from "../supporters.js";

function getWaveSurfer() {
  const g = globalThis;
  if (g.WaveSurfer && typeof g.WaveSurfer.create === "function") return g.WaveSurfer;
  throw new Error("WaveSurfer not loaded");
}

/**
 * @param {HTMLElement} waveWrap
 * @param {HTMLAudioElement} audio
 */
function bindWaveformPlayback(waveWrap, audio) {
  let clickFull = false;
  audio.addEventListener("ended", () => {
    clickFull = false;
  });
  waveWrap.addEventListener("click", (e) => {
    e.preventDefault();
    if (!audio.src) return;
    clickFull = true;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  });
  waveWrap.addEventListener("mouseenter", () => {
    if (!audio.src) return;
    if (clickFull) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  });
  waveWrap.addEventListener("mouseleave", () => {
    if (clickFull) return;
    audio.pause();
    audio.currentTime = 0;
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mountResultsScreen(root, ctx) {
  mountAuthCornerLeave(ctx);

  const wsSock = ctx.mpWs;
  /** True while we close the socket on purpose (avoid restart overlay). */
  let teardownClose = false;
  const r = ctx.results || {};
  const winners = r.winners || [];
  const board = r.leaderboard || [];
  const beats = Array.isArray(r.beats) ? r.beats : [];
  const playerId = ctx.playerId ? String(ctx.playerId) : "";
  const apiBase = getApiBase();
  const noWinnerTwoPlayers = r.no_winner_two_players === true;
  const participants = Array.isArray(r.participants) ? r.participants : [];

  /** @type {Map<string, number>} */
  const voteByPlayerId = new Map(
    board.map((row) => [String(row.player_id ?? ""), Number(row.votes) || 0]),
  );

  const beatsByVotes = [...beats].sort((a, b) => {
    const pa = String(a.player_id ?? "");
    const pb = String(b.player_id ?? "");
    const va = voteByPlayerId.get(pa) ?? 0;
    const vb = voteByPlayerId.get(pb) ?? 0;
    if (vb !== va) return vb - va;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, {
      sensitivity: "base",
    });
  });

  const winnerNameHtml =
    winners.length > 0
      ? winners
          .map((w) => supporterDisplayNameInnerHtml(w))
          .join('<span class="results-winner-sep" aria-hidden="true"> · </span>')
      : "";

  const winnerBlock = noWinnerTwoPlayers
    ? `<p class="results-no-winner-2p">No Winner - Only 2 Players!</p>`
    : winners.length > 0
      ? `<div class="results-winner">WINNER<br/><span class="results-winner-name">${winnerNameHtml}</span></div>`
      : `<p class="arcade-hint">No winner this round.</p>`;

  const beatsSection =
    beats.length > 0 && playerId
      ? `
      <section class="results-beats-section" aria-label="Results beats">
        <div class="results-beat-grid" id="results-beat-grid"></div>
      </section>
    `
      : beats.length > 0
        ? `<p class="arcade-hint results-beats-miss">Sign in required to replay beats.</p>`
        : "";

  const rematchSection =
    participants.length > 0 && wsSock instanceof WebSocket
      ? `
      <section class="results-rematch" aria-label="Rematch vote">
        <p class="arcade-hint results-rematch-title">Rematch — all players must agree</p>
        <ul class="results-rematch-list" id="results-rematch-list"></ul>
        <button type="button" class="arcade-btn arcade-btn-secondary" id="results-rematch-btn">Rematch</button>
      </section>
    `
      : "";

  root.innerHTML = `
    <div class="screen results arcade-panel">
      <h2 class="arcade-heading">RESULTS</h2>
      ${winnerBlock}
      ${beatsSection}
      ${rematchSection}
      <button type="button" class="arcade-btn arcade-btn-primary" id="results-home">Main menu</button>
    </div>
  `;

  /** @type {Set<string>} */
  const rematchVoted = new Set();
  let preserveWs = false;

  const rematchListEl = root.querySelector("#results-rematch-list");
  if (rematchListEl && participants.length > 0) {
    for (const row of participants) {
      const pid = String(row.player_id ?? "");
      const name = String(row.name ?? pid);
      const li = document.createElement("li");
      li.className = "results-rematch-row";
      li.dataset.playerId = pid;
      const tick = document.createElement("span");
      tick.className = "results-rematch-tick";
      tick.setAttribute("aria-hidden", "true");
      const nm = document.createElement("span");
      nm.className = "results-rematch-name";
      nm.innerHTML = supporterDisplayNameInnerHtml(name);
      li.append(tick, nm);
      rematchListEl.appendChild(li);
    }
  }

  const paintRematchTicks = () => {
    if (!rematchListEl) return;
    rematchListEl.querySelectorAll(".results-rematch-row").forEach((row) => {
      const pid = row.dataset.playerId || "";
      const tick = row.querySelector(".results-rematch-tick");
      if (tick) tick.textContent = rematchVoted.has(pid) ? "✓" : "";
    });
    const btn = root.querySelector("#results-rematch-btn");
    if (btn instanceof HTMLButtonElement && playerId) {
      btn.disabled = rematchVoted.has(playerId);
    }
  };

  paintRematchTicks();

  /** @type {{ destroy: () => void }[]} */
  const waveCleanups = [];
  /** @type {string[]} */
  const objectUrls = [];

  const gridEl = root.querySelector("#results-beat-grid");

  const revealGrid = () => {
    if (!gridEl) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        gridEl.classList.add("results-beat-grid--reveal");
      });
    });
  };

  if (beats.length > 0 && playerId && gridEl) {
    let pending = beats.length;

    const oneDone = () => {
      pending -= 1;
      if (pending <= 0) revealGrid();
    };

    beatsByVotes.forEach((b, i) => {
      const pid = String(b.player_id ?? "");
      const name = String(b.name ?? pid);
      const path = String(b.url ?? "");
      const votes = voteByPlayerId.get(pid) ?? 0;
      if (!path) {
        oneDone();
        return;
      }

      const card = document.createElement("article");
      card.className = "card results-beat-card";
      card.style.setProperty("--stagger", String(i));

      const head = document.createElement("div");
      head.className = "card-head results-beat-card-head";
      const title = document.createElement("h2");
      title.className = "card-title";
      title.innerHTML = supporterDisplayNameInnerHtml(name);
      const voteEl = document.createElement("span");
      voteEl.className = "results-beat-vote-count";
      voteEl.setAttribute("aria-label", `${votes} votes`);
      voteEl.textContent = String(votes);

      head.append(title, voteEl);

      const waveWrap = document.createElement("div");
      waveWrap.className = "waveform-wrap empty";
      waveWrap.textContent = "…";

      const audio = document.createElement("audio");
      audio.preload = "auto";
      bindWaveformPlayback(waveWrap, audio);

      card.append(head, waveWrap, audio);
      gridEl.appendChild(card);

      const fullUrl = `${apiBase}${path}?requester=${encodeURIComponent(playerId)}`;

      void (async () => {
        try {
          const res = await fetch(fullUrl, { headers: authHeadersMultipart() });
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const objUrl = URL.createObjectURL(blob);
          objectUrls.push(objUrl);
          audio.src = objUrl;

          waveWrap.textContent = "";
          waveWrap.classList.remove("empty");

          const WaveSurfer = getWaveSurfer();
          const wsur = WaveSurfer.create({
            container: waveWrap,
            height: 72,
            waveColor: "#b01010",
            progressColor: "#ffffff",
            cursorWidth: 0,
            interact: false,
            url: objUrl,
          });
          waveCleanups.push({
            destroy: () => {
              try {
                wsur.destroy();
              } catch {
                /* ignore */
              }
            },
          });
        } catch {
          waveWrap.textContent = "—";
          waveWrap.classList.add("empty");
        } finally {
          oneDone();
        }
      })();
    });
  }

  const unmountMpChat =
    wsSock instanceof WebSocket ? mountMpChat({ ws: wsSock, playerId }) : () => {};

  if (wsSock instanceof WebSocket) {
    wsSock.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      ingestMpChatMessage(m);
      notifyRematchWant(m, playerId);
      if (m.type === "rematch_vote_update" && Array.isArray(m.voted_player_ids)) {
        rematchVoted.clear();
        for (const id of m.voted_player_ids) rematchVoted.add(String(id));
        paintRematchTicks();
      }
      if (m.type === "lobby_update" && m.lobby && m.lobby.state === "lobby") {
        preserveWs = true;
        import("./lobby.js").then((mod) => {
          ctx.navigate(mod.mountLobbyScreen, {
            mpWs: wsSock,
            playerId,
            lobby: m.lobby,
          });
        });
        return;
      }
      if (m.type === "error") {
        mpChatHandleErrorPayload(m);
      }
    };
    wsSock.onclose = () => {
      if (teardownClose || preserveWs) return;
      showServerRestartingWait();
    };
  }

  root.querySelector("#results-rematch-btn")?.addEventListener("click", () => {
    if (!(wsSock instanceof WebSocket) || wsSock.readyState !== WebSocket.OPEN) return;
    if (playerId && rematchVoted.has(playerId)) return;
    playSfxMinor();
    try {
      wsSock.send(JSON.stringify({ type: "rematch_vote" }));
    } catch {
      /* ignore */
    }
  });

  root.querySelector("#results-home")?.addEventListener("click", async () => {
    playSfxMinor();
    teardownClose = true;
    try {
      wsSock?.close();
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
    unmountMpChat();
    waveCleanups.forEach((c) => c.destroy());
    waveCleanups.length = 0;
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls.length = 0;
    root.innerHTML = "";
    if (!preserveWs) {
      teardownClose = true;
      try {
        wsSock?.close();
      } catch {
        /* ignore */
      }
    }
  };
}
