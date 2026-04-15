/**
 * Apply server ``match_resync`` (same shape as HTTP match_sync) after WS resume.
 * Uses dynamic imports to avoid circular deps with screens.
 * @param {object} ctx
 * @param {Record<string, unknown>} m
 * @param {"lobby"|"cook"|"upload"|"voting_slideshow"|"vote_selection"|"results"} screenId
 * @returns {Promise<boolean>} true if navigated to another screen
 */
export async function applyMatchResyncFromPayload(ctx, m, screenId) {
  if (m.type !== "match_resync") return false;
  const lid = String(m.lobby_id ?? "");
  const ctxLid = String(ctx.lobbyId ?? ctx.lobby?.lobby_id ?? "");
  if (!lid || lid !== ctxLid) return false;

  const ws = ctx.mpWs;
  if (!(ws instanceof WebSocket) || ws.readyState !== WebSocket.OPEN) return false;

  const pid = String(ctx.playerId ?? "");
  const st = String(m.match_state ?? "");

  if (st === "lobby" || st === "generating") {
    if (screenId === "lobby") return false;
    const { mountLobbyScreen } = await import("./screens/lobby.js");
    const lobbyLike = {
      lobby_id: lid,
      spice: m.spice,
      is_public: m.is_public !== false,
      state: m.state ?? st,
      host_id: m.host_id ?? "",
      cook_duration_min: Number(m.cook_duration_min) || 10,
      anonymous_voting: Boolean(m.anonymous_voting),
      players: Array.isArray(m.players) ? m.players : [],
      drumkit: m.drumkit && typeof m.drumkit === "object" ? m.drumkit : {},
      votes: m.votes,
      cook_finished: m.cook_finished,
      uploaded: m.uploaded,
      slideshow_completed: m.slideshow_completed,
      player_count: m.player_count,
      max_players: m.max_players,
    };
    ctx.navigate(mountLobbyScreen, {
      mpWs: ws,
      playerId: pid,
      lobby: lobbyLike,
      mpName: ctx.mpName || ctx.username,
      mpSpices: ctx.mpSpices,
      lobbyCode: ctx.lobbyCode ?? null,
    });
    return true;
  }

  if (st === "cooking") {
    if (screenId === "cook") return false;
    const drum = m.drumkit && typeof m.drumkit === "object" ? m.drumkit : {};
    const seed = Number(drum.seed);
    const spice = Number(m.spice);
    if (!Number.isFinite(seed) || !Number.isFinite(spice)) return false;
    const { mountCookScreen } = await import("./screens/cook.js");
    ctx.navigate(mountCookScreen, {
      mpWs: ws,
      playerId: pid,
      lobbyId: lid,
      seed,
      spice,
      sounds: ctx.sounds && typeof ctx.sounds === "object" ? ctx.sounds : {},
      cookDurationMin: Number(m.cook_duration_min) || 10,
    });
    return true;
  }

  if (st === "upload") {
    if (screenId === "upload") return false;
    const ur = m.upload_deadline_ts;
    if (ur == null || !Number.isFinite(Number(ur))) return false;
    const { mountUploadScreen } = await import("./screens/upload.js");
    ctx.navigate(mountUploadScreen, {
      mpWs: ws,
      playerId: pid,
      lobbyId: lid,
      uploadDeadlineTs: Number(ur),
    });
    return true;
  }

  if (st === "voting") {
    if (screenId === "voting_slideshow" || screenId === "vote_selection") return false;
    const vu = m.votes_unlock_at;
    const vc = m.votes_close_at;
    const { mountVotingSlideshowScreen } = await import("./screens/votingSlideshow.js");
    ctx.navigate(mountVotingSlideshowScreen, {
      mpWs: ws,
      playerId: pid,
      lobbyId: lid,
      beats: Array.isArray(m.beats) ? m.beats : [],
      votesUnlockAt: typeof vu === "number" && Number.isFinite(vu) ? vu : undefined,
      votesCloseAt:
        typeof vc === "number" && Number.isFinite(vc)
          ? vc
          : typeof vu === "number" && Number.isFinite(vu)
            ? vu + 30
            : undefined,
    });
    return true;
  }

  if (st === "results" && m.results && typeof m.results === "object") {
    if (screenId === "results") return false;
    const { mountResultsScreen } = await import("./screens/results.js");
    ctx.navigate(mountResultsScreen, {
      mpWs: ws,
      playerId: pid,
      results: m.results,
    });
    return true;
  }

  return false;
}

/**
 * Lobby-only: merge match_resync flat fields into current lobby object for paint.
 * @param {Record<string, unknown>} m
 * @param {object} lobby
 */
export function mergeMatchResyncIntoLobby(m, lobby) {
  if (m.type !== "match_resync") return lobby;
  const lid = String(m.lobby_id ?? "");
  if (!lid || lid !== String(lobby?.lobby_id ?? "")) return lobby;
  const st = String(m.match_state ?? "");
  if (st !== "lobby" && st !== "generating") return lobby;
  return {
    ...lobby,
    lobby_id: lid,
    spice: m.spice ?? lobby.spice,
    is_public: m.is_public ?? lobby.is_public,
    state: m.state ?? st,
    host_id: m.host_id ?? lobby.host_id,
    cook_duration_min: Number(m.cook_duration_min) || lobby.cook_duration_min || 10,
    anonymous_voting: Boolean(m.anonymous_voting),
    players: Array.isArray(m.players) ? m.players : lobby.players || [],
    drumkit: m.drumkit && typeof m.drumkit === "object" ? m.drumkit : lobby.drumkit || {},
  };
}
