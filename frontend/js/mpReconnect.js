/**
 * Multiplayer WebSocket reconnect with resume_player_id + exponential backoff.
 */
import { validateSession } from "./authApi.js";
import { getWsUrl } from "./apiOrigin.js";
import { getStoredMpLobbyId, getStoredMpPlayerId } from "./mpSeatStorage.js";
import { showMpReconnectBanner, hideMpReconnectBanner } from "./mpReconnectBanner.js";
import { showServerRestartingWait } from "./serverRestartOverlay.js";

const MAX_ATTEMPTS = 15;
const BASE_DELAY_MS = 500;

function jitter() {
  return Math.floor(Math.random() * 280);
}

/**
 * Wait until first ``connected`` message (resume or fresh).
 * @param {WebSocket} nw
 * @param {number} timeoutMs
 */
function waitForConnectedMessage(nw, timeoutMs) {
  return new Promise((resolve) => {
    const tm = window.setTimeout(() => {
      nw.removeEventListener("message", onMsg);
      resolve(false);
    }, timeoutMs);
    const onMsg = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "connected" && m.player_id) {
          window.clearTimeout(tm);
          nw.removeEventListener("message", onMsg);
          resolve(true);
        }
      } catch {
        /* ignore */
      }
    };
    nw.addEventListener("message", onMsg);
  });
}

/**
 * @param {CloseEvent | null} ev
 * @param {{
 *   ctx: object,
 *   intentionalLeave: () => boolean,
 *   preserveWs: () => boolean,
 *   onReplaceSocket: (nw: WebSocket) => void,
 * }} opts
 */
export async function runMpWsReconnect(ev, opts) {
  if (opts.intentionalLeave() || opts.preserveWs()) return;
  if (ev && (ev.code === 4401 || ev.code === 4400 || ev.code === 4404)) return;

  const lid = getStoredMpLobbyId();
  const pid = getStoredMpPlayerId();
  if (!lid || !pid) {
    showServerRestartingWait();
    import("./screens/multiplayerHub.js").then((m) => opts.ctx.navigate(m.mountMultiplayerHubScreen));
    return;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    showMpReconnectBanner(attempt, MAX_ATTEMPTS);
    const sessionOk = await validateSession();
    if (!sessionOk) {
      hideMpReconnectBanner();
      import("./screens/modeSelect.js").then((mod) => opts.ctx.navigate(mod.mountModeSelectScreen));
      return;
    }

    const delay = Math.min(14_000, BASE_DELAY_MS * 2 ** (attempt - 1)) + jitter();
    await new Promise((r) => window.setTimeout(r, delay));

    if (opts.intentionalLeave() || opts.preserveWs()) {
      hideMpReconnectBanner();
      return;
    }

    const url = getWsUrl({ resumePlayerId: pid });
    /** @type {WebSocket | null} */
    let nw = null;
    try {
      nw = new WebSocket(url);
    } catch {
      continue;
    }

    const opened = await new Promise((resolve) => {
      const t = window.setTimeout(() => resolve(false), 12_000);
      nw.addEventListener(
        "open",
        () => {
          window.clearTimeout(t);
          resolve(true);
        },
        { once: true },
      );
      nw.addEventListener(
        "error",
        () => {
          window.clearTimeout(t);
          resolve(false);
        },
        { once: true },
      );
    });

    if (!opened || !nw) {
      try {
        nw?.close();
      } catch {
        /* ignore */
      }
      continue;
    }

    const gotConnected = await waitForConnectedMessage(nw, 10_000);
    if (!gotConnected) {
      try {
        nw.close();
      } catch {
        /* ignore */
      }
      continue;
    }

    hideMpReconnectBanner();
    opts.ctx.mpWs = nw;
    opts.onReplaceSocket(nw);
    return;
  }

  hideMpReconnectBanner();
  showServerRestartingWait();
  import("./screens/multiplayerHub.js").then((m) => opts.ctx.navigate(m.mountMultiplayerHubScreen));
}
