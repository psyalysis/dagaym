/**
 * Build the same kit the server would — pick_index + paths from /api/kit-manifest.
 */

import { getCdnBase } from "./apiOrigin.js";

const MANIFEST_STORAGE_KEY_PREFIX = "bb_kit_manifest_v19";
const TARGET_RATE = 44100;

export const KIT_SOUND_KEYS = [
  "snares",
  "claps",
  "hihats",
  "openhats",
  "808s",
  "percs",
  "fx",
  "Vox",
  "synth1",
  "synth2",
  "synth3",
  "kicks",
];

/**
 * All EDM manifest stems (``/api/kit-manifest?genre=edm`` must list every folder).
 * The playable kit uses 12 stems: 4 synths + 8 drums (see ``getEdmKitSoundKeysForSeed``).
 */
export const KIT_EDM_MANIFEST_KEYS = [
  "ArpSynths",
  "BassSynths",
  "Claps",
  "ClosedHats",
  "Cymbals",
  "ImpactsRisers",
  "Kicks",
  "LeadSynths",
  "OpenHats",
  "PadSynths",
  "Percs",
  "PluckSynths",
  "Snares",
  "SynthSynths",
];

/** @deprecated Use ``KIT_EDM_MANIFEST_KEYS``. */
export const KIT_SOUND_KEYS_EDM = KIT_EDM_MANIFEST_KEYS;

export const SYNTH_KEYS = ["synth1", "synth2", "synth3"];

const EDM_SYNTH_FIXED = /** @type {const} */ ([
  "BassSynths",
  "LeadSynths",
  "PluckSynths",
]);

/** One of these is chosen per kit (same for everyone: seed + spice + ``EDM_VARIANT_PICK_SLOT``). */
const EDM_VARIANT_POOL = /** @type {const} */ ([
  "ArpSynths",
  "PadSynths",
  "SynthSynths",
]);

/** Dedicated slot for variant pick — must not overlap stem slots 0..11. */
const EDM_VARIANT_PICK_SLOT = 0xed01;

export const EDM_DRUM_KEYS_ORDERED = /** @type {const} */ ([
  "Cymbals",
  "ImpactsRisers",
  "ClosedHats",
  "OpenHats",
  "Percs",
  "Claps",
  "Kicks",
  "Snares",
]);

export const DRUM_KEYS = KIT_SOUND_KEYS.filter((k) => !k.startsWith("synth"));

/**
 * @param {number} seed
 * @param {number} spice
 * @returns {string}
 */
export function pickEdmFourthSynthKey(seed, spice) {
  const i = pickIndex(
    seed,
    EDM_VARIANT_PICK_SLOT,
    spice,
    EDM_VARIANT_POOL.length,
  );
  return EDM_VARIANT_POOL[i];
}

/**
 * Four synth slots: Bass, Lead, Pluck, plus one of Arp / Pad / Synth stack.
 * @param {number} seed
 * @param {number} spice
 * @returns {string[]}
 */
export function getEdmSynthKeysForSeed(seed, spice) {
  return [...EDM_SYNTH_FIXED, pickEdmFourthSynthKey(seed, spice)];
}

/**
 * Full EDM kit key order (matches ``pickIndex`` slot indices 0..11).
 * @param {number} seed
 * @param {number} spice
 * @returns {string[]}
 */
export function getEdmKitSoundKeysForSeed(seed, spice) {
  return [...getEdmSynthKeysForSeed(seed, spice), ...EDM_DRUM_KEYS_ORDERED];
}

/**
 * @param {string} [genre]
 * @param {number} [seed] Required for EDM (lobby / solo kit).
 * @param {number} [spice]
 * @returns {readonly string[]}
 */
export function getKitSoundKeys(genre = "trap", seed, spice) {
  if (normalizeKitGenre(genre) !== "edm") return KIT_SOUND_KEYS;
  const s = Number(seed);
  const p = Number(spice);
  if (!Number.isFinite(s) || !Number.isFinite(p)) {
    return getEdmKitSoundKeysForSeed(0, 0);
  }
  return getEdmKitSoundKeysForSeed(s, p);
}

/**
 * @param {string} [genre]
 * @param {number} [seed]
 * @param {number} [spice]
 * @returns {readonly string[]}
 */
export function getSynthKeys(genre = "trap", seed, spice) {
  if (normalizeKitGenre(genre) !== "edm") return SYNTH_KEYS;
  const s = Number(seed);
  const p = Number(spice);
  if (!Number.isFinite(s) || !Number.isFinite(p)) {
    return getEdmSynthKeysForSeed(0, 0);
  }
  return getEdmSynthKeysForSeed(s, p);
}

/**
 * @param {string} [genre]
 * @returns {readonly string[]}
 */
export function getDrumKeys(genre = "trap") {
  return normalizeKitGenre(genre) === "edm" ? EDM_DRUM_KEYS_ORDERED : DRUM_KEYS;
}

/** Dataset stems are OGG (CDN or /media/dataset); zips use this extension. */
export const KIT_SOUND_FILE_EXT = "ogg";

/** R2 trap pack root (``https://…/TrapRefined/<slot>/``). */
export const CDN_TRAP_DRUM_PREFIX = "TrapRefined";

const TRAP_LEGACY_PREFIXES = [
  "beat-battle-assets/TrapRefined",
  "beat-battle-assets/DRACO/TrapRefined",
  "DRACO/TrapRefined",
];

function stripRel(rel) {
  return String(rel || "").replace(/^\/+/, "");
}

function joinKey(base, tail) {
  if (!tail) return base;
  return `${base}/${tail}`.replace(/\/{2,}/g, "/");
}

/**
 * Manifest / dataset relative path → CDN object key under ``TrapRefined/…``.
 * Accepts legacy ``beat-battle-assets/…``, ``trap/<slot>/…``, and canonical ``TrapRefined/…``.
 * @param {string} rel
 * @returns {string}
 */
export function normalizeTrapDrumDatasetPath(rel) {
  const s = stripRel(rel);
  if (!s) return s;
  const root = CDN_TRAP_DRUM_PREFIX;
  if (s === root || s.startsWith(`${root}/`)) return s;
  for (const leg of TRAP_LEGACY_PREFIXES) {
    if (s === leg || s.startsWith(`${leg}/`)) {
      const tail = s === leg ? "" : s.slice(leg.length + 1);
      return tail ? joinKey(root, tail) : root;
    }
  }
  if (s === "trap" || s.startsWith("trap/")) {
    const tail = s === "trap" ? "" : s.slice("trap/".length);
    return tail ? joinKey(root, tail) : root;
  }
  return s;
}

/** R2 EDM pack root (manifest logical paths use ``edm/<category>/``). */
export const CDN_EDM_PREFIX = "EDM";

const EDM_LEGACY_NESTED = "beat-battle-assets/EDM";

/**
 * Logical / legacy path → CDN key under ``EDM/…``.
 * @param {string} rel
 * @returns {string}
 */
export function normalizeEdmDatasetPath(rel) {
  const s = stripRel(rel);
  if (!s) return s;
  const root = CDN_EDM_PREFIX;
  if (s === root || s.startsWith(`${root}/`)) return s;
  if (s === EDM_LEGACY_NESTED || s.startsWith(`${EDM_LEGACY_NESTED}/`)) {
    const tail = s === EDM_LEGACY_NESTED ? "" : s.slice(EDM_LEGACY_NESTED.length + 1);
    return tail ? joinKey(root, tail) : root;
  }
  return s;
}

/** ``edm/…`` in JSON → ``EDM/…`` fetch path. */
function edmLogicalToCdnKey(rel) {
  if (rel === "edm" || rel.startsWith("edm/")) {
    const rest = rel === "edm" ? "" : rel.slice("edm/".length);
    return joinKey(CDN_EDM_PREFIX, rest);
  }
  return rel;
}

/**
 * @param {string | undefined | null} genre
 * @returns {"trap" | "edm"}
 */
export function normalizeKitGenre(genre) {
  const s = String(genre ?? "trap").trim().toLowerCase();
  return s === "edm" ? "edm" : "trap";
}

/**
 * Map manifest-relative paths to CDN object keys.
 * @param {string} relPath
 * @param {string} [genre]
 * @returns {string}
 */
export function cdnDatasetRelPath(relPath, genre = "trap") {
  const g = normalizeKitGenre(genre);
  const raw = stripRel(relPath);
  if (!raw) return "";
  if (g === "edm") {
    return edmLogicalToCdnKey(normalizeEdmDatasetPath(raw));
  }
  return normalizeTrapDrumDatasetPath(raw);
}

/**
 * Path under ``dataset/`` for ``GET /media/dataset/…`` (matches R2 layout for EDM).
 * @param {string} relPath
 * @param {string} [genre]
 * @returns {string}
 */
export function mediaPathForDatasetMount(relPath, genre = "trap") {
  const g = normalizeKitGenre(genre);
  const raw = stripRel(relPath);
  if (!raw) return "";
  if (g === "edm") {
    return edmLogicalToCdnKey(normalizeEdmDatasetPath(raw));
  }
  return normalizeTrapDrumDatasetPath(raw);
}

function float32Bits(x) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, Number(x), true);
  return new DataView(buf).getUint32(0, true) >>> 0;
}

/**
 * @param {number} seed
 * @param {number} slotIndex
 * @param {number} spice
 * @param {number} n
 * @returns {number}
 */
export function pickIndex(seed, slotIndex, spice, n) {
  if (n <= 0) throw new Error("n must be positive");
  const spiceBits = float32Bits(spice);
  const s0 =
    (Number(seed) ^
      (slotIndex * 1_000_003) ^
      spiceBits ^
      ((slotIndex << 16) >>> 0)) >>>
    0;
  let t = (s0 + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
  const out = (t ^ (t >>> 14)) >>> 0;
  const r = out / 4294967296;
  let idx = Math.floor(r * n);
  if (idx >= n) idx = n - 1;
  return idx;
}

/**
 * @param {string} apiBase
 * @returns {Promise<{ version?: number; sampleRate?: number; keys: Record<string, string[]> }>}
 */
/** Legacy CDN manifests used singular keys (``snare`` → ``snares``); see ``KIT_MANIFEST_CDN_FILES_TRAP``. */
const LEGACY_KIT_KEY_MAP = {
  snare: "snares",
  clap: "claps",
  hihat: "hihats",
  open_hat: "openhats",
  "808": "808s",
  perc: "percs",
  kick: "kicks",
  vox: "Vox",
};

/**
 * @param {{ keys?: Record<string, unknown> } | null | undefined} data
 * @returns {typeof data}
 */
function normalizeLegacyKitManifestKeys(data) {
  if (!data || typeof data !== "object" || typeof data.keys !== "object" || !data.keys)
    return data;
  const keys = data.keys;
  for (const [oldKey, newKey] of Object.entries(LEGACY_KIT_KEY_MAP)) {
    if (keys[newKey] !== undefined) continue;
    const v = keys[oldKey];
    if (Array.isArray(v)) keys[newKey] = v;
  }
  return data;
}

function isValidManifestShape(data, genre = "trap") {
  if (!data || typeof data !== "object" || typeof data.keys !== "object" || !data.keys)
    return false;
  const need =
    normalizeKitGenre(genre) === "edm" ? KIT_EDM_MANIFEST_KEYS : KIT_SOUND_KEYS;
  return need.every((k) => {
    const arr = data.keys[k];
    if (!Array.isArray(arr)) return false;
    if (arr.length > 0) return true;
    return false;
  });
}

/**
 * Kit manifest: same CDN base as kit audio — trap uses trap-refined only (no legacy fallbacks).
 */
const KIT_MANIFEST_CDN_FILES_TRAP = ["kit-manifest-trap-refined.json"];

const KIT_MANIFEST_CDN_FILES_EDM = ["kit-manifest-edm-refined.json"];

/**
 * @param {string} apiBase
 * @param {string} [genre] trap | edm
 * @returns {Promise<{ version?: number; sampleRate?: number; keys: Record<string, string[]> }>}
 */
export async function fetchKitManifest(apiBase, genre = "trap") {
  const g = normalizeKitGenre(genre);
  const storageKey = `${MANIFEST_STORAGE_KEY_PREFIX}_${g}`;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const cdn = getCdnBase().replace(/\/+$/, "");
  const cdnFiles = g === "edm" ? KIT_MANIFEST_CDN_FILES_EDM : KIT_MANIFEST_CDN_FILES_TRAP;
  if (cdn) {
    for (const name of cdnFiles) {
      try {
        const cdnRes = await fetch(`${cdn}/${name}`, {
          cache: "no-store",
        });
        if (cdnRes.ok) {
          const data = normalizeLegacyKitManifestKeys(await cdnRes.json());
          if (isValidManifestShape(data, g)) {
            try {
              sessionStorage.setItem(storageKey, JSON.stringify(data));
            } catch {
              /* ignore */
            }
            return data;
          }
        }
      } catch {
        /* try next */
      }
    }
  }
  const base = apiBase.replace(/\/+$/, "");
  const res = await fetch(
    `${base}/api/kit-manifest?genre=${encodeURIComponent(g)}`,
  );
  if (!res.ok) throw new Error(`kit-manifest: ${res.status}`);
  const data = normalizeLegacyKitManifestKeys(await res.json());
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(data));
  } catch {
    /* ignore */
  }
  return data;
}

function encodedDatasetPath(relPath) {
  const rel = String(relPath || "").replace(/^\/+/, "");
  if (!rel) return "";
  return rel
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}

/**
 * Dataset files must be OGG; HTML/error pages decode as "failed" in the browser.
 * @param {string} relPath
 * @param {ArrayBuffer} arr
 */
function assertOggPayload(relPath, arr) {
  if (arr.byteLength < 4) {
    throw new Error(`Empty or truncated audio (${relPath}).`);
  }
  const u8 = new Uint8Array(arr, 0, 4);
  const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (sig === "OggS") return;
  const peekLen = Math.min(256, arr.byteLength);
  const peek = new Uint8Array(arr, 0, peekLen);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(peek);
  const t = text.trimStart();
  if (
    t.startsWith("<") ||
    t.startsWith("<!") ||
    /^\s*html/i.test(text.slice(0, 24))
  ) {
    throw new Error(
      `Got a web page instead of audio for ${relPath}. Check CDN URL or try again.`,
    );
  }
  throw new Error(`Expected OGG audio for ${relPath} (missing OggS header).`);
}

/**
 * Preferred URL for a dataset file (CDN when configured, else API).
 * When a CDN base is set, kit audio is loaded only from that host (R2); there is no
 * fallback to ``/media/dataset/`` so missing CDN keys fail loudly instead of 404ing the API.
 * Trap: ``trap/snares/…`` / ``trap/synths/…`` → ``TrapRefined/…``;
 * EDM: ``edm/hihats/…`` → ``EDM/…``.
 */
export function datasetMediaUrl(apiBase, relPath, genre = "trap") {
  const cdn = getCdnBase().replace(/\/+$/, "");
  const logicalPath = cdn
    ? cdnDatasetRelPath(relPath, genre)
    : mediaPathForDatasetMount(relPath, genre);
  const enc = encodedDatasetPath(logicalPath);
  if (cdn && enc) return `${cdn}/${enc}`;
  const base = apiBase.replace(/\/+$/, "");
  return `${base}/media/dataset/${enc}`;
}

/**
 * @param {string} apiBase
 * @param {string} relPath
 * @returns {Promise<ArrayBuffer>} OGG bytes (validated)
 */
async function fetchDatasetArrayBuffer(apiBase, relPath, genre = "trap") {
  const mountPath = mediaPathForDatasetMount(relPath, genre);
  const apiEnc = encodedDatasetPath(mountPath);
  if (!apiEnc) throw new Error(`Invalid dataset path: ${relPath}`);
  const base = apiBase.replace(/\/+$/, "");
  const apiUrl = `${base}/media/dataset/${apiEnc}`;
  const cdn = getCdnBase().replace(/\/+$/, "");
  if (cdn) {
    const cdnEnc = encodedDatasetPath(cdnDatasetRelPath(relPath, genre));
    const cdnUrl = `${cdn}/${cdnEnc}`;
    try {
      const res = await fetch(cdnUrl);
      if (res.ok) {
        const arr = await res.arrayBuffer();
        assertOggPayload(relPath, arr);
        return arr;
      }
      throw new Error(
        `CDN ${cdnUrl} returned HTTP ${res.status} for ${relPath}. Kit audio is expected on R2 at that object key (no /media/dataset fallback when CDN is configured).`,
      );
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("CDN ")) throw e;
      const hint = e instanceof Error ? e.message : String(e);
      throw new Error(
        `CDN fetch failed for ${relPath} (${cdnUrl}): ${hint}. Fix R2/CORS or set beatBattleCdnBase / beat-battle-cdn meta.`,
      );
    }
  }
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`fetch ${relPath}: ${res.status}`);
  const arr = await res.arrayBuffer();
  assertOggPayload(relPath, arr);
  return arr;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(bin);
}

/**
 * @param {string} apiBase
 * @param {string} relPath
 * @returns {Promise<string>} base64 OGG (dataset file bytes)
 */
async function fetchMediaKitBase64(apiBase, relPath, genre = "trap") {
  const arr = await fetchDatasetArrayBuffer(apiBase, relPath, genre);
  return arrayBufferToBase64(arr);
}

/**
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<AudioBuffer>}
 */
export async function resampleTo44100(audioBuffer) {
  if (audioBuffer.sampleRate === TARGET_RATE) return audioBuffer;
  const ch = audioBuffer.numberOfChannels;
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(ch, frames, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

/**
 * @param {AudioContext} audioContext
 * @param {string} apiBase
 * @param {string} relPath
 * @returns {Promise<AudioBuffer>}
 */
export async function fetchDecodeResample(
  audioContext,
  apiBase,
  relPath,
  genre = "trap",
) {
  const arr = await fetchDatasetArrayBuffer(apiBase, relPath, genre);
  let decoded;
  try {
    decoded = await audioContext.decodeAudioData(arr.slice(0));
  } catch (e) {
    const hint = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not decode ${relPath}: ${hint}`);
  }
  return resampleTo44100(decoded);
}

function writeStr(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/**
 * Old WAV helper — kits use OGG on the wire; this still shows up in a few places.
 * @param {AudioBuffer} buffer
 * @returns {string} base64 WAV
 */
export function audioBufferToWavBase64(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const blockAlign = numChannels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = buffer.getChannelData(c)[i];
      s = Math.max(-1, Math.min(1, s));
      const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      view.setInt16(o, v, true);
      o += 2;
    }
  }
  const bytes = new Uint8Array(arrayBuffer);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(bin);
}

/**
 * @param {object} p
 * @param {number} p.seed
 * @param {number} p.spice
 * @param {string} p.apiBase
 * @param {AudioContext} p.audioContext
 * @param {object} p.manifest
 * @returns {Promise<{ buffers: Record<string, AudioBuffer>; base64: Record<string, string> }>}
 */
export async function loadSynthBuffersAndMp3Base64Parallel({
  seed,
  spice,
  apiBase,
  audioContext,
  manifest,
  genre = "trap",
}) {
  const keysObj = manifest.keys;
  const kitSoundKeys = getKitSoundKeys(genre, seed, spice);
  const synthKeys = getSynthKeys(genre, seed, spice);
  const buffers = /** @type {Record<string, AudioBuffer>} */ ({});
  const base64 = /** @type {Record<string, string>} */ ({});
  await Promise.all(
    synthKeys.map(async (key) => {
      const slot = kitSoundKeys.indexOf(key);
      const paths = keysObj[key];
      if (!paths?.length) throw new Error(`No samples for ${key}`);
      const idx = pickIndex(seed, slot, spice, paths.length);
      const relPath = paths[idx];
      const arr = await fetchDatasetArrayBuffer(apiBase, relPath, genre);
      base64[key] = arrayBufferToBase64(arr);
      try {
        const decoded = await audioContext.decodeAudioData(arr.slice(0));
        buffers[key] = await resampleTo44100(decoded);
      } catch (e) {
        const hint = e instanceof Error ? e.message : String(e);
        console.warn(
          `[kit] decodeAudioData failed for ${relPath} (${key}):`,
          hint,
        );
        buffers[key] = undefined;
      }
    }),
  );
  return { buffers, base64 };
}

/**
 * Same work as loadSynthBuffers… — some screens still import this name only.
 * @param {object} p
 * @param {number} p.seed
 * @param {number} p.spice
 * @param {string} p.apiBase
 * @param {AudioContext} p.audioContext
 * @param {object} p.manifest
 * @returns {Promise<Record<string, AudioBuffer>>}
 */
export async function loadSynthAudioBuffersParallel(args) {
  const { buffers } = await loadSynthBuffersAndMp3Base64Parallel(args);
  return buffers;
}

/**
 * @param {object} p
 * @param {number} p.seed
 * @param {number} p.spice
 * @param {string} p.apiBase
 * @param {object} p.manifest
 * @param {(ev: { key: string; step: number; total: number }) => void} [p.onProgress]
 * @returns {Promise<Record<string, string>>}
 */
export async function loadDrumKitBase64Parallel({
  seed,
  spice,
  apiBase,
  manifest,
  onProgress,
  genre = "trap",
}) {
  const keysObj = manifest.keys;
  const kitSoundKeys = getKitSoundKeys(genre, seed, spice);
  const drumKeys = getDrumKeys(genre);
  const total = drumKeys.length;
  let done = 0;
  const entries = await Promise.all(
    drumKeys.map(async (key) => {
      const slot = kitSoundKeys.indexOf(key);
      const paths = keysObj[key];
      if (!paths?.length) {
        done += 1;
        onProgress?.({ key, step: done, total });
        return [key, ""];
      }
      const idx = pickIndex(seed, slot, spice, paths.length);
      const b64 = await fetchMediaKitBase64(apiBase, paths[idx], genre);
      done += 1;
      onProgress?.({ key, step: done, total });
      return [key, b64];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Slow path: one stem at a time. Prefer the parallel helpers if you want a progress bar.
 * @param {object} p
 * @param {number} p.seed
 * @param {number} p.spice
 * @param {string} p.apiBase
 * @param {(ev: { key: string; step: number; total: number }) => void} [p.onProgress]
 */
export async function buildKitFromSeed({
  seed,
  spice,
  apiBase,
  onProgress,
  genre = "trap",
}) {
  const manifest = await fetchKitManifest(apiBase, genre);
  const keysObj = manifest.keys;
  const kitSoundKeys = getKitSoundKeys(genre, seed, spice);
  const out = /** @type {Record<string, string>} */ ({});
  const n = kitSoundKeys.length;
  for (let i = 0; i < n; i++) {
    const key = kitSoundKeys[i];
    const paths = keysObj[key];
    if (!paths?.length) {
      out[key] = "";
      onProgress?.({ key, step: i + 1, total: n });
      continue;
    }
    const idx = pickIndex(seed, i, spice, paths.length);
    out[key] = await fetchMediaKitBase64(apiBase, paths[idx], genre);
    onProgress?.({ key, step: i + 1, total: n });
  }
  return out;
}

/**
 * @param {AudioContext} ac
 * @param {AudioBuffer} buffer
 */
export function playBufferOnce(ac, buffer) {
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.connect(ac.destination);
  void ac.resume().catch(() => {});
  src.start(0);
}
