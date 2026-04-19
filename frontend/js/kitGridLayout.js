/**
 * How kit tiles are grouped on screen — keys line up with KIT_SOUND_KEYS / server.
 */

import { normalizeKitGenre } from "./kitFromSeed.js";

/** Short UI labels for EDM stem keys (not "Arp Synths"). */
const EDM_SLOT_SHORT = /** @type {Record<string, string>} */ ({
  ArpSynths: "ARP",
  BassSynths: "BASS",
  LeadSynths: "LEAD",
  PadSynths: "PAD",
  PluckSynths: "PLUCK",
  SynthSynths: "SYNTH",
  Cymbals: "CYMBALS",
  ImpactsRisers: "IMPACTS / RISERS",
  ClosedHats: "CLOSED HATS",
  OpenHats: "OPEN HATS",
  Percs: "PERCS",
  Claps: "CLAPS",
  Kicks: "KICKS",
  Snares: "SNARES",
});

function humanizeKitKey(key) {
  if (key.startsWith("synth") && key.length > "synth".length) {
    const n = key.slice("synth".length);
    return n ? `Synth ${n}` : key;
  }
  if (/^[A-Z]/.test(key)) {
    return key.replace(/([a-z\d])([A-Z])/g, "$1 $2").trim();
  }
  return key.replace(/_/g, " ");
}

/**
 * Card heading for a kit stem (internal key stays ``key`` for filenames / API).
 * @param {string} key
 * @param {string} [genre]
 * @returns {string}
 */
export function kitSlotDisplayLabel(key, genre = "trap") {
  if (normalizeKitGenre(genre) === "edm") {
    const s = EDM_SLOT_SHORT[key];
    if (s) return s;
  }
  return humanizeKitKey(key);
}

/** @type {{ label: string, keys: string[] }[]} */
export const KIT_DRUM_SECTIONS = [
  { label: "Texture", keys: ["percs", "fx", "Vox"] },
  { label: "Hats", keys: ["hihats", "openhats"] },
  { label: "Core", keys: ["kicks", "snares", "claps"] },
  { label: "Low / body", keys: ["808s"] },
];

/**
 * @param {string} [genre]
 * @returns {{ label: string, keys: string[] }[]}
 */
export function getKitDrumSections(genre = "trap") {
  void normalizeKitGenre(genre);
  return KIT_DRUM_SECTIONS;
}

/** Trap-style EDM: synth row, then drums top → bottom. */
const KIT_EDM_DRUM_SECTIONS = /** @type {const} */ [
  {
    label: "Cymbals, impacts & percs",
    keys: ["Cymbals", "ImpactsRisers", "Percs"],
  },
  { label: "Hats", keys: ["ClosedHats", "OpenHats"] },
  { label: "Kicks, snares & claps", keys: ["Kicks", "Snares", "Claps"] },
];

/**
 * @param {HTMLElement} container
 * @param {{ synthKeys: string[], appendCard: (key: string) => HTMLElement, genre?: string }} opts
 */
export function mountKitLayoutShell(
  container,
  { synthKeys, appendCard, genre },
) {
  container.classList.add("kit-layout");
  container.replaceChildren();

  if (normalizeKitGenre(genre) === "edm") {
    const synthBand = document.createElement("div");
    synthBand.className = "kit-band kit-band--synth";
    const synthTitle = document.createElement("h3");
    synthTitle.className = "kit-section-heading";
    synthTitle.textContent = "Synths";
    const synthRow = document.createElement("div");
    synthRow.className = "kit-row kit-row--cols-4";
    for (const k of synthKeys) synthRow.appendChild(appendCard(k));
    synthBand.append(synthTitle, synthRow);

    const divider = document.createElement("div");
    divider.className = "kit-divider";
    divider.setAttribute("aria-hidden", "true");

    const drumBand = document.createElement("div");
    drumBand.className = "kit-band kit-band--drums";
    for (const sec of KIT_EDM_DRUM_SECTIONS) {
      const section = document.createElement("section");
      section.className = "kit-section";
      const h = document.createElement("h3");
      h.className = "kit-section-heading";
      h.textContent = sec.label;
      const row = document.createElement("div");
      const n = sec.keys.length;
      row.className =
        n === 1
          ? "kit-row kit-row--cols-1"
          : n === 2
            ? "kit-row kit-row--cols-2"
            : "kit-row kit-row--cols-3";
      for (const k of sec.keys) row.appendChild(appendCard(k));
      section.append(h, row);
      drumBand.appendChild(section);
    }

    container.append(synthBand, divider, drumBand);
    return;
  }

  const synthBand = document.createElement("div");
  synthBand.className = "kit-band kit-band--synth";
  const synthTitle = document.createElement("h3");
  synthTitle.className = "kit-section-heading";
  synthTitle.textContent = "Synths";
  const synthRow = document.createElement("div");
  synthRow.className = "kit-row kit-row--cols-3";
  for (const k of synthKeys) synthRow.appendChild(appendCard(k));
  synthBand.append(synthTitle, synthRow);

  const divider = document.createElement("div");
  divider.className = "kit-divider";
  divider.setAttribute("aria-hidden", "true");

  const drumBand = document.createElement("div");
  drumBand.className = "kit-band kit-band--drums";
  for (const sec of getKitDrumSections(genre)) {
    const section = document.createElement("section");
    section.className = "kit-section";
    const h = document.createElement("h3");
    h.className = "kit-section-heading";
    h.textContent = sec.label;
    const row = document.createElement("div");
    row.className =
      sec.keys.length === 1
        ? "kit-row kit-row--cols-1"
        : sec.keys.length === 2
          ? "kit-row kit-row--cols-2"
          : "kit-row kit-row--cols-3";
    for (const k of sec.keys) row.appendChild(appendCard(k));
    section.append(h, row);
    drumBand.appendChild(section);
  }

  container.append(synthBand, divider, drumBand);
}
