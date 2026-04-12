/**
 * Static supporter list (display names, matched case-insensitively after trim).
 */
import { escapeHtml } from "./rankUi.js";

export const SUPPORTER_TOOLTIP = "This person is a supporter!";

/** Add display names exactly as players appear in the UI (any casing). */
const SUPPORTER_DISPLAY_NAMES = [
  "globagorb",
  "cowguts"
];

const NORMALIZED = new Set(
  SUPPORTER_DISPLAY_NAMES.map((n) => String(n).trim().toLowerCase()).filter(Boolean),
);

/**
 * @param {unknown} name
 */
export function isSupporterDisplayName(name) {
  if (name == null) return false;
  const s = String(name).trim();
  if (!s) return false;
  return NORMALIZED.has(s.toLowerCase());
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/**
 * Safe HTML for a single visible display name (heart + tooltip wrapper when supporter).
 * @param {unknown} rawDisplayName
 */
export function supporterDisplayNameInnerHtml(rawDisplayName) {
  const name = String(rawDisplayName ?? "");
  const safe = escapeHtml(name);
  if (!isSupporterDisplayName(name)) return safe;
  const tip = escapeAttr(SUPPORTER_TOOLTIP);
  return `<span class="supporter-wrap" data-corner-tooltip="${tip}" aria-label="${tip}" tabindex="0"><span class="supporter-heart" aria-hidden="true">❤️</span> ${safe}</span>`;
}

/**
 * For plain-text contexts (toasts): prefix with heart when supporter.
 * @param {unknown} rawDisplayName
 */
export function supporterPlainPrefix(rawDisplayName) {
  return isSupporterDisplayName(rawDisplayName) ? "❤️ " : "";
}
