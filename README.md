# Gamelan Practice

A self-calibrating practice tool for gamelan (and other tuned percussion). It
measures **your** instrument's tuning from samples you record — because gamelan
are tuned to themselves, with no canonical scale — then transcribes a
performance against that tuning and plays it back with each strike highlighted.

Runs as a plain web app (open `src/index.html` in a browser) and packages into a
small Mac/Windows desktop app with Tauri.

## What it does

- **Calibrate.** Name the instrument and its number of voices, then either drop
  one *sweep* (each voice struck once, in order) or one *clip per voice*. It
  measures each fundamental and a quality score, flags unclear samples, and lets
  you label the voices in your own numbering. Save the result as an instrument
  profile (JSON) to reuse.
- **Play along.** Load a performance; it snaps every strike to your measured
  voices and shows a bar strip + a note stream in your labels, with a gold
  play-head, seek bar, and speed control. Strikes that match no voice are
  flagged (an out-of-vocabulary signal that later drives section detection).

No scale and no voice count are hardcoded. Audio in: WAV, MP3, M4A/AAC/MP4,
FLAC (and AIFF where the platform webview supports it), decoded via the Web
Audio API.

## Run as a web app

Open `src/index.html` in any modern browser. Nothing to install.

## Build the desktop app (Tauri v2)

Prerequisites: [Rust](https://rustup.rs) and [Node.js](https://nodejs.org), plus
your platform's Tauri system dependencies — see
<https://v2.tauri.app/start/prerequisites/>. Build **on** the OS you are
targeting; macOS binaries cannot be produced on Windows/Linux and vice-versa.

```bash
npm install
# one-time: generate the app icon set from a 1024x1024 PNG you provide
npm run tauri icon path/to/your-icon.png
# build installers for this OS (.dmg/.app on macOS, .msi/.exe on Windows)
npm run tauri build
# or run it live during development:
npm run tauri dev
```

Output lands in `src-tauri/target/release/bundle/`.

If your installed Tauri CLI's config schema has drifted from this scaffold, the
sure fallback is to scaffold fresh — `npm create tauri-app@latest` (choose the
vanilla, no-framework template) — then drop this repo's `src/` in as the
frontend and set `build.frontendDist` to `../src`.

## Layout

```
src/index.html            the app (self-contained; analysis engine inlined)
engine/gamelan_engine.mjs the analysis engine as a standalone ES module
src-tauri/                Tauri desktop wrapper (config + Rust shell)
```

The engine (FFT, onset detection, pitch, self-calibration, snapping,
transcription) is dependency-free and was validated against a Python reference
to sub-cent tuning accuracy and identical transcription output.

## Status

Working and browser-verified: calibration, transcription, and play-along. Next:
assisted section detection (propose breaks from pauses + out-of-vocabulary
strikes, confirm with one tap), then desktop-packaging polish.

*A personal music project.*
