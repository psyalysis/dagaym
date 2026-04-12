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

/** Upload phase: window is open — time to upload your beat. */
export function playSfxUploadAlarm() {
  playFile("Alarm.wav", 0.88);
}

/** Everyone else left mid-match — same asset as upload alarm. */
export function playSfxSoloMatchAlarm() {
  playFile("Alarm.wav", 0.88);
}

export function playSfxPlayerJoin() {
  playFile("PlayerJoin.wav", 0.88);
}

export function playSfxPlayerLeave() {
  playFile("PlayerLeave.wav", 0.88);
}
