/**
 * Visual grouping for kit preview (solo + cook). Slot keys match KIT_SOUND_KEYS / backend.
 */

/** @type {{ label: string, keys: string[] }[]} */
export const KIT_DRUM_SECTIONS = [
  { label: "Texture", keys: ["perc", "fx", "vox"] },
  { label: "Hats", keys: ["hihat", "open_hat"] },
  { label: "Core", keys: ["kick", "snare", "clap"] },
  { label: "Low / body", keys: ["808"] },
];

/**
 * @param {HTMLElement} container
 * @param {{ synthKeys: string[], appendCard: (key: string) => HTMLElement }} opts
 */
export function mountKitLayoutShell(container, { synthKeys, appendCard }) {
  container.classList.add("kit-layout");
  container.replaceChildren();

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
  for (const sec of KIT_DRUM_SECTIONS) {
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
