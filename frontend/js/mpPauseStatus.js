/**
 * Server flag: no new MP matches (matches pause_matches_cache TTL on backend).
 */

export const MP_PAUSE_MESSAGE =
  "Server is restarting. Waiting for matches to finish.";

/** @returns {Promise<boolean>} */
export async function fetchMpPauseStatus() {
  const r = await fetch("/api/mp-pause-status", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`mp pause status ${r.status}`);
  const data = await r.json();
  return Boolean(data.pause_new_matches);
}
