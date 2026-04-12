/**
 * VoteSelectionScreen — vote by clicking a beat preview (waveform); hover to preview audio.
 */
import { authHeadersMultipart } from "../authApi.js";
import { getApiBase } from "../apiOrigin.js";
import { notifyMpServerError } from "../errorToast.js";
import { showServerRestartingWait } from "../serverRestartOverlay.js";
import {
  navigateToMenuAfterLobbyDissolved,
  notifyMpPlayerJoin,
  notifyMpPlayerLeave,
} from "../mpPresenceToast.js";
import { mountAuthCornerLeave } from "../authCorner.js";
import { supporterDisplayNameInnerHtml } from "../supporters.js";
import { ingestMpChatMessage, mountMpChat, mpChatHandleErrorPayload } from "../mpChat.js";
import { playSfxMajor } from "../sfx.js";
import { mountResultsScreen } from "./results.js";

function getWaveSurfer() {
  const g = globalThis;
  if (g.WaveSurfer && typeof g.WaveSurfer.create === "function") return g.WaveSurfer;
  throw new Error("WaveSurfer not loaded");
}

/**
 * Hover-only preview (click on card votes, not full replay).
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

export function mountVoteSelectionScreen(root, ctx) {
  mountAuthCornerLeave(ctx);

  const wsSock = ctx.mpWs;
  const playerId = ctx.playerId ? String(ctx.playerId) : "";
  const beats = ctx.beats || [];
  const unlock = ctx.votesUnlockAt ?? 0;
  const apiBase = typeof ctx.apiBase === "string" ? ctx.apiBase : getApiBase();
  let preserveWs = false;
  /** True while unmount closes the socket on purpose (avoid restart overlay). */
  let teardownClose = false;
  let unlockInterval = 0;
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

  const unmountMpChat =
    wsSock instanceof WebSocket ? mountMpChat({ ws: wsSock, playerId }) : () => {};

  const setVoteCardsLocked = (locked) => {
    voteUiLocked = locked;
    root.querySelectorAll(".vote-beat-card").forEach((el) => {
      el.classList.toggle("vote-beat-card--locked", locked);
    });
  };

  const renderLocked = () => {
    teardownBeatWaveforms();
    root.innerHTML = `
      <div class="screen vote arcade-panel">
        <h2 class="arcade-heading">VOTE</h2>
        <p class="arcade-hint">Votes unlock after the slideshow finishes…</p>
      </div>
    `;
  };

  const renderVote = () => {
    if (unlockInterval) {
      clearInterval(unlockInterval);
      unlockInterval = 0;
    }
    teardownBeatWaveforms();
    voteUiLocked = false;

    if (targets.length === 0) {
      root.innerHTML = `
        <div class="screen vote arcade-panel">
          <h2 class="arcade-heading">VOTE</h2>
          <p class="arcade-hint">No other beats to vote for.</p>
        </div>
      `;
      return;
    }

    root.innerHTML = `
      <div class="screen vote arcade-panel">
        <h2 class="arcade-heading">Vote for the best beat</h2>
        <p class="arcade-hint vote-beat-hint">Hover waveform to preview · click card to vote · not your track</p>
        <div class="grid vote-beat-grid" id="vote-beat-grid"></div>
        <p class="arcade-error" id="vote-err"></p>
      </div>
    `;

    const gridEl = root.querySelector("#vote-beat-grid");
    if (!gridEl) return;
    if (!playerId) {
      const miss = document.createElement("p");
      miss.className = "arcade-hint";
      miss.textContent = "Sign in required to load beats for voting.";
      gridEl.replaceWith(miss);
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
          wsSock.send(JSON.stringify({ type: "vote_cast", target_player_id: tid }));
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
  };

  if (Date.now() / 1000 >= unlock) {
    renderVote();
  } else {
    renderLocked();
    unlockInterval = window.setInterval(() => {
      if (Date.now() / 1000 >= unlock) {
        clearInterval(unlockInterval);
        unlockInterval = 0;
        renderVote();
      }
    }, 400);
  }

  const onMessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    ingestMpChatMessage(m);
    if (m.type === "lobby_dissolved") {
      preserveWs = true;
      void navigateToMenuAfterLobbyDissolved(ctx, wsSock, m);
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
      ctx.navigate(mountResultsScreen, { mpWs: wsSock, results: m, playerId });
    }
  };
  wsSock.onclose = () => {
    if (preserveWs || teardownClose) return;
    showServerRestartingWait();
  };
  wsSock.onmessage = onMessage;

  return () => {
    unmountMpChat();
    if (unlockInterval) clearInterval(unlockInterval);
    teardownBeatWaveforms();
    teardownClose = true;
    root.innerHTML = "";
    if (!preserveWs) {
      try {
        wsSock.close();
      } catch {
        /* ignore */
      }
    }
  };
}
