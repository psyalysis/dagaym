/**
 * Pick a winner — click a card to vote, hover to hear a snippet.
 */
import { authHeadersMultipart } from "../authApi.js";
import { getApiBase } from "../apiOrigin.js";
import { notifyMpServerError } from "../errorToast.js";
import { dismissServerRestartingWait, showServerRestartingWait } from "../serverRestartOverlay.js";
import { applyMatchResyncFromPayload } from "../mpMatchResync.js";
import { runMpWsReconnect } from "../mpReconnect.js";
import { saveMpSeat } from "../mpSeatStorage.js";
import {
  navigateToMenuAfterLobbyDissolved,
  notifyMpPlayerJoin,
  notifyMpPlayerLeave,
} from "../mpPresenceToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { supporterDisplayNameInnerHtml } from "../supporters.js";
import { ingestMpChatMessage, mountMpChat, mpChatHandleErrorPayload } from "../mpChat.js";
import {
  applyMatchWsToLobby,
  lobbyLikeFromMatchSync,
  normalizeLobbyLike,
  phaseTimerRowHtml,
  progressHintSlotHtml,
  syncMatchProgressHint,
  updatePhaseTimerBar,
} from "../mpMatchRoster.js";
import { fetchMatchSync, pollMatchSync } from "../mpMatchSync.js";
import { playSfxMajor } from "../sfx.js";
import { mountResultsScreen } from "./results.js";

function getWaveSurfer() {
  const g = globalThis;
  if (g.WaveSurfer && typeof g.WaveSurfer.create === "function") return g.WaveSurfer;
  throw new Error("WaveSurfer not loaded");
}

/**
 * Hover = preview; the card click is the actual vote (not a full replay).
 * @param {HTMLElement} waveWrap
 * @param {HTMLAudioElement} audio
 */
function bindVoteWaveHover(waveWrap, audio) {
  waveWrap.addEventListener("mouseenter", () => {
    if (!audio.src) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  });
  waveWrap.addEventListener("mouseleave", () => {
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

/** If server omits `votes_close_at` (matches backend `VOTING_COLLECT_S`). */
const VOTE_COLLECT_FALLBACK_S = 30;

export function mountVoteSelectionScreen(root, ctx) {
  mountAuthCornerLeave(ctx);

  const playerId = ctx.playerId ? String(ctx.playerId) : "";
  const lobbyId = ctx.lobbyId;
  const beats = ctx.beats || [];
  /** Server wall-clock when voting opens globally (may move earlier when everyone finishes the slideshow). */
  let unlockAt =
    typeof ctx.votesUnlockWall === "number" && Number.isFinite(ctx.votesUnlockWall)
      ? ctx.votesUnlockWall
      : typeof ctx.votesUnlockAt === "number" && Number.isFinite(ctx.votesUnlockAt)
        ? ctx.votesUnlockAt
        : 0;
  let votesCloseAt =
    typeof ctx.votesCloseAt === "number" && Number.isFinite(ctx.votesCloseAt)
      ? ctx.votesCloseAt
      : unlockAt > 0
        ? unlockAt + VOTE_COLLECT_FALLBACK_S
        : null;
  /** Local user finished the slideshow (matches server ``slideshow_completed``). */
  let slideshowDone = ctx.slideshowCompleted === true;
  /** True after ``renderVote`` has run. */
  let voteUiShown = false;
  const apiBase = typeof ctx.apiBase === "string" ? ctx.apiBase : getApiBase();
  let preserveWs = false;
  let resultsPollNav = false;
  /** Intentional socket close — skip the "server restarting" overlay. */
  let teardownClose = false;
  let unlockInterval = 0;
  /** Countdown while vote cards are active. */
  let voteDeadlineInterval = 0;
  let voteUiLocked = false;

  /** @type {{ destroy: () => void }[]} */
  const waveCleanups = [];
  /** @type {string[]} */
  const objectUrls = [];

  const teardownBeatWaveforms = () => {
    while (waveCleanups.length) {
      const c = waveCleanups.pop();
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
    }
    while (objectUrls.length) {
      const u = objectUrls.pop();
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    }
  };

  const targets = beats.filter((b) => b.player_id !== playerId);

  const lid0 = String(lobbyId || "").trim();
  const pid0 = String(playerId || "").trim();
  if (lid0 && pid0) saveMpSeat(lid0, pid0);

  let unmountMpChat =
    ctx.mpWs instanceof WebSocket
      ? mountMpChat({ ws: ctx.mpWs, getWs: () => ctx.mpWs, playerId, continueSession: true })
      : () => {};

  /** @type {ReturnType<typeof normalizeLobbyLike>} */
  let lobbyView = normalizeLobbyLike({});
  const syncProgressHint = () => syncMatchProgressHint(root, "mp-corner-vote", "vote", lobbyView);

  const applyVoteTimingFromSync = (sync) => {
    if (!sync || String(sync.match_state) !== "voting") return;
    const vu = sync.votes_unlock_at;
    if (typeof vu === "number" && Number.isFinite(vu)) unlockAt = vu;
    const vc = sync.votes_close_at;
    if (typeof vc === "number" && Number.isFinite(vc)) votesCloseAt = vc;
    const done = sync.slideshow_completed;
    if (Array.isArray(done) && playerId && done.some((id) => String(id) === playerId)) {
      slideshowDone = true;
    }
  };

  const maybeShowVote = () => {
    if (voteUiShown) return;
    const now = Date.now() / 1000;
    if (now >= unlockAt || slideshowDone) {
      voteUiShown = true;
      renderVote();
    }
  };

  void (async () => {
    const sync = await fetchMatchSync(String(lobbyId));
    applyVoteTimingFromSync(sync);
    const L = lobbyLikeFromMatchSync(sync);
    if (L && Array.isArray(L.players) && L.players.length) {
      lobbyView = normalizeLobbyLike(L);
      syncProgressHint();
    }
    maybeShowVote();
  })();

  const stopResultsPoll = pollMatchSync(
    String(lobbyId),
    (sync) => {
      if (!resultsPollNav && !preserveWs) {
        const L = lobbyLikeFromMatchSync(sync);
        if (L && Array.isArray(L.players) && L.players.length) {
          lobbyView = normalizeLobbyLike(L);
          syncProgressHint();
        }
      }
      if (String(sync.match_state) === "voting") {
        applyVoteTimingFromSync(sync);
        maybeShowVote();
      }
      if (resultsPollNav || preserveWs) return;
      if (String(sync.match_state) !== "results" || !sync.results || typeof sync.results !== "object") {
        return;
      }
      resultsPollNav = true;
      preserveWs = true;
      stopResultsPoll();
      ctx.navigate(mountResultsScreen, {
        mpWs: ctx.mpWs,
        results: sync.results,
        playerId,
      });
    },
    4500,
  );

  const setVoteCardsLocked = (locked) => {
    voteUiLocked = locked;
    root.querySelectorAll(".vote-beat-card").forEach((el) => {
      el.classList.toggle("vote-beat-card--locked", locked);
    });
  };

  const renderLocked = () => {
    teardownBeatWaveforms();
    if (voteDeadlineInterval) {
      clearInterval(voteDeadlineInterval);
      voteDeadlineInterval = 0;
    }
    const lockPhaseStart = Date.now() / 1000;
    const unlockTotalSec = Math.max(1, unlockAt - lockPhaseStart);
    root.innerHTML = `
      <div class="screen vote arcade-panel">
        <div class="mp-panel-head">
          <h2 class="arcade-heading mp-panel-head-title">VOTE!</h2>
          <div class="mp-panel-head-timer">${phaseTimerRowHtml("mp-vote-unlock-phase")}</div>
          <div class="mp-panel-head-roster">${progressHintSlotHtml("mp-corner-vote")}</div>
        </div>
        <p class="arcade-hint">Waiting for everyone to finish the slideshow…</p>
      </div>
    `;
    syncProgressHint();
    const tickUnlock = () => {
      const remain = unlockAt - Date.now() / 1000;
      updatePhaseTimerBar(root, "mp-vote-unlock-phase", unlockTotalSec, Math.max(0, remain));
      if (remain <= 0 || slideshowDone) {
        if (unlockInterval) clearInterval(unlockInterval);
        unlockInterval = 0;
        voteUiShown = true;
        renderVote();
      }
    };
    tickUnlock();
    unlockInterval = window.setInterval(tickUnlock, 400);
  };

  const renderVote = () => {
    voteUiShown = true;
    if (unlockInterval) {
      clearInterval(unlockInterval);
      unlockInterval = 0;
    }
    if (voteDeadlineInterval) {
      clearInterval(voteDeadlineInterval);
      voteDeadlineInterval = 0;
    }
    teardownBeatWaveforms();
    voteUiLocked = false;

    const timerRowHtml =
      votesCloseAt != null ? `<div aria-live="polite">${phaseTimerRowHtml("mp-vote-deadline-phase")}</div>` : "";

    const startDeadlineTick = () => {
      if (votesCloseAt == null) return;
      const tickDeadline = () => {
        const now = Date.now() / 1000;
        const windowS =
          unlockAt > 0 && votesCloseAt > unlockAt ? votesCloseAt - unlockAt : VOTE_COLLECT_FALLBACK_S;
        const remainInVoteWindow = Math.max(0, votesCloseAt - now);
        updatePhaseTimerBar(root, "mp-vote-deadline-phase", Math.max(1, windowS), remainInVoteWindow);
      };
      voteDeadlineInterval = window.setInterval(tickDeadline, 250);
      tickDeadline();
    };

    if (targets.length === 0) {
      root.innerHTML = `
        <div class="screen vote arcade-panel">
          <div class="mp-panel-head">
            <h2 class="arcade-heading mp-panel-head-title">VOTE</h2>
            <div class="mp-panel-head-timer">${timerRowHtml}</div>
            <div class="mp-panel-head-roster">${progressHintSlotHtml("mp-corner-vote")}</div>
          </div>
          <p class="arcade-hint">No other beats to vote for.</p>
        </div>
      `;
      syncProgressHint();
      startDeadlineTick();
      return;
    }

    root.innerHTML = `
      <div class="screen vote arcade-panel">
        <div class="mp-panel-head">
          <h2 class="arcade-heading mp-panel-head-title">Vote!</h2>
          <div class="mp-panel-head-timer">${timerRowHtml}</div>
          <div class="mp-panel-head-roster">${progressHintSlotHtml("mp-corner-vote")}</div>
        </div>
        <p class="arcade-hint vote-beat-hint">Hover waveform to preview · click card to vote · not your track</p>
        <div class="grid vote-beat-grid" id="vote-beat-grid"></div>
        <p class="arcade-error" id="vote-err"></p>
      </div>
    `;
    syncProgressHint();

    const gridEl = root.querySelector("#vote-beat-grid");
    if (!gridEl) {
      startDeadlineTick();
      return;
    }
    if (!playerId) {
      const miss = document.createElement("p");
      miss.className = "arcade-hint";
      miss.textContent = "Sign in required to load beats for voting.";
      gridEl.replaceWith(miss);
      startDeadlineTick();
      return;
    }

    targets.forEach((b) => {
      const tid = String(b.player_id ?? "");
      const name = String(b.name ?? tid);
      const path = String(b.url ?? "");
      if (!tid || !path) return;

      const card = document.createElement("article");
      card.className = "card vote-beat-card";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Vote for ${name}`);

      const head = document.createElement("div");
      head.className = "card-head";
      const title = document.createElement("h2");
      title.className = "card-title";
      title.innerHTML = supporterDisplayNameInnerHtml(name);
      head.appendChild(title);

      const waveWrap = document.createElement("div");
      waveWrap.className = "waveform-wrap vote-beat-wave empty";
      waveWrap.textContent = "…";

      const audio = document.createElement("audio");
      audio.preload = "auto";
      bindVoteWaveHover(waveWrap, audio);

      card.append(head, waveWrap, audio);
      gridEl.appendChild(card);

      const submitVote = () => {
        if (voteUiLocked || !tid) return;
        setVoteCardsLocked(true);
        playSfxMajor();
        try {
          ctx.mpWs.send(JSON.stringify({ type: "vote_cast", target_player_id: tid }));
          const err = root.querySelector("#vote-err");
          if (err) err.textContent = "Vote sent…";
        } catch {
          setVoteCardsLocked(false);
        }
      };

      card.addEventListener("click", () => submitVote());
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          submitVote();
        }
      });

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
        }
      })();
    });
    startDeadlineTick();
  };

  const onMessage = async (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "connected") return;
    if (m.type === "match_resync") {
      await applyMatchResyncFromPayload(ctx, m, "vote_selection");
      return;
    }
    ingestMpChatMessage(m);
    if (m.type === "lobby_dissolved") {
      preserveWs = true;
      void navigateToMenuAfterLobbyDissolved(ctx, ctx.mpWs, m);
      return;
    }
    notifyMpPlayerJoin(m, playerId);
    notifyMpPlayerLeave(m, playerId);
    if (m.type === "error") {
      mpChatHandleErrorPayload(m);
      if (m.error_code !== "MP_CHAT_COOLDOWN") {
        setVoteCardsLocked(false);
        const err = root.querySelector("#vote-err");
        if (err) err.textContent = m.message || "Error";
      }
      notifyMpServerError(m);
    }
    if (m.type === "results") {
      preserveWs = true;
      stopResultsPoll();
      ctx.navigate(mountResultsScreen, { mpWs: ctx.mpWs, results: m, playerId });
      return;
    }
    if (m.type === "votes_timing" && String(m.lobby_id) === String(lobbyId)) {
      if (typeof m.votes_unlock_at === "number" && Number.isFinite(m.votes_unlock_at)) {
        unlockAt = m.votes_unlock_at;
      }
      if (typeof m.votes_close_at === "number" && Number.isFinite(m.votes_close_at)) {
        votesCloseAt = m.votes_close_at;
      }
      maybeShowVote();
      return;
    }
    if (
      m.type === "lobby_update" ||
      m.type === "cook_finished_update" ||
      m.type === "beat_uploaded" ||
      m.type === "vote_cast"
    ) {
      lobbyView = applyMatchWsToLobby(lobbyView, m);
      syncProgressHint();
    }
  };
  const onVoteSelectSocketClose = (ev) => {
    if (preserveWs || teardownClose) return;
    showServerRestartingWait();
    dismissServerRestartingWait();
    void runMpWsReconnect(ev, {
      ctx,
      intentionalLeave: () => teardownClose,
      preserveWs: () => preserveWs,
      onReplaceSocket: (nw) => {
        ctx.mpWs = nw;
        unmountMpChat();
        unmountMpChat = mountMpChat({
          ws: nw,
          getWs: () => ctx.mpWs,
          playerId,
          continueSession: true,
        });
        nw.onmessage = onMessage;
        nw.addEventListener("close", onVoteSelectSocketClose, { once: true });
      },
    });
  };
  ctx.mpWs.addEventListener("close", onVoteSelectSocketClose, { once: true });
  ctx.mpWs.onmessage = onMessage;

  if (Date.now() / 1000 >= unlockAt || slideshowDone) {
    voteUiShown = true;
    renderVote();
  } else {
    renderLocked();
  }

  return () => {
    stopResultsPoll();
    unmountMpChat();
    if (unlockInterval) clearInterval(unlockInterval);
    if (voteDeadlineInterval) clearInterval(voteDeadlineInterval);
    teardownBeatWaveforms();
    teardownClose = true;
    root.innerHTML = "";
    if (!preserveWs) {
      try {
        ctx.mpWs.removeEventListener("close", onVoteSelectSocketClose);
      } catch {
        /* ignore */
      }
      try {
        ctx.mpWs.close();
      } catch {
        /* ignore */
      }
    }
  };
}
