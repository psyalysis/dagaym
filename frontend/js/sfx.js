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
  playFile("UIMajor.mp3");
}

/** Routine navigation / secondary actions. */
export function playSfxMinor() {
  playFile("UIMinor.mp3");
}

export function playSfxOn() {
  playFile("UIOn.mp3");
}

export function playSfxOff() {
  playFile("UIOff.mp3");
}

/** Multiplayer match / cook phase begins. */
export function playSfxBeatBattle() {
  playFile("BeatBattle.mp3", 0.92);
}

/** Upload phase: window is open — time to upload your beat. */
export function playSfxUploadAlarm() {
  playFile("Alarm.mp3", 0.88);
}

/** Everyone else left mid-match — same asset as upload alarm. */
export function playSfxSoloMatchAlarm() {
  playFile("Alarm.mp3", 0.88);
}

export function playSfxPlayerJoin() {
  playFile("PlayerJoin.mp3", 0.88);
}

export function playSfxPlayerLeave() {
  playFile("PlayerLeave.mp3", 0.88);
}
