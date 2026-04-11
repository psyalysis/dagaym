/**
 * UI sound effects (paths relative to this module → ../sfx/).
 */
const dir = new URL("../sfx/", import.meta.url);

function playFile(filename, volume = 0.88) {
  try {
    const a = new Audio(new URL(filename, dir).href);
    a.volume = volume;
    void a.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Big steps: generate kit, enter matchmaking, ready, upload beat, cast vote, etc. */
export function playSfxMajor() {
  playFile("UIMajor.wav");
}

/** Routine navigation / secondary actions. */
export function playSfxMinor() {
  playFile("UIMinor.wav");
}

export function playSfxOn() {
  playFile("UIOn.wav");
}

export function playSfxOff() {
  playFile("UIOff.wav");
}

/** Multiplayer match / cook phase begins. */
export function playSfxBeatBattle() {
  playFile("BeatBattle.wav", 0.92);
}

/** Upload phase: 30 seconds left. */
export function playSfxUploadWarning30() {
  playFile("30SecWarning.wav", 0.9);
}

/** Upload phase: time expired. */
export function playSfxUploadAlarm() {
  playFile("Alarm.wav", 0.88);
}
