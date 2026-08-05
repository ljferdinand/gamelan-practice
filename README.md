# Gamelan Practice

A self-calibrating practice tool for gamelan. It measures **your** instrument's
tuning from samples you record — because gamelan are tuned to themselves, with no
canonical scale — then transcribes a performance against that tuning and plays it
back with each strike highlighted.

**[Run it in your browser →](https://ljferdinand.github.io/gamelan-practice/)**
Nothing to install. Everything runs locally; no audio is uploaded anywhere.

## What it does

- **Calibrate.** Name the instrument and its number of voices, then either drop
  one *sweep* (each voice struck once, in order) or one *clip per voice*. It
  measures each fundamental and a quality score, flags unclear samples, folds
  away a bar accidentally caught twice, and lets you preview (▶) or remove (🗑)
  any detected voice. A sensitivity slider re-measures the sweep without
  re-uploading. Save the result as an instrument profile (JSON) to reuse.
- **Number it your way.** The table reads highest note first, and you pick each
  label from a dropdown built from your own **numbering set** for one octave.
  Sweep direction is irrelevant, because everything is anchored to measured
  pitch.
- **Play along.** Load a performance; it snaps every strike to your measured
  voices and shows a bar strip plus a note stream in your labels, with a gold
  play-head, seek bar, speed control, and transport buttons that step one
  four-note *gatra* at a time (arrow keys work too). Strikes matching no voice
  are flagged.

## Notation conventions: this tool does not assume one tradition

Gamelan cipher notation differs by region, and the differences invert each other,
so both are configurable rather than hardcoded.

- **Numbering set.** Defaults to `1,2,3,4,5` (a five-tone octave). Central
  Javanese *sléndro* is often `1,2,3,5,6`; Javanese *pélog* can run to 7;
  Sundanese *daminatila* is `1,2,3,4,5` (da-mi-na-ti-la). The set also defines
  the octave size, so an instrument with an extra tone is handled by adding it.
- **Number direction.** Central Javanese kepatihan numbers ascend with pitch.
  Sundanese notation runs the other way, with 1 as the *highest* pitch. Because
  you label from the highest voice downward, either convention works.
- **Octave dots.** Toggle. Central Javanese: a dot above means the higher
  octave. Sundanese: the reverse, a dot above means the octave *below*. The
  choice is saved in the instrument profile.

Octave registers are assigned by **position**, counting voices in groups of the
octave size, deliberately not by measuring 2:1 ratios — gamelan octaves are
frequently stretched or compressed, and cutting bands at exact doublings can drop
a group-starting bar into the wrong register.

Audio in: WAV, MP3, M4A/AAC/MP4, FLAC, and AIFF where the platform webview
supports it, decoded via the Web Audio API.

## Run it locally instead

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
.github/workflows/        GitHub Pages deployment
```

The engine (FFT, onset detection, pitch, self-calibration, near-duplicate
folding, octave registers, snapping, transcription) is dependency-free and was
validated against a Python reference to sub-cent tuning accuracy and identical
transcription output.

## Status

Working and browser-verified: calibration, numbering, transcription, and
play-along. Next: assisted section detection (propose breaks from pauses plus
out-of-vocabulary strikes, confirm with one tap).

## License

Copyright (C) 2026 Luke Ferdinand.

Free software under the **GNU Affero General Public License v3.0 or later**
(AGPL-3.0-or-later). You may use, study, share, and modify it; if you distribute
it or run a modified version as a network service, you must pass on the same
freedoms and make your source available under the same license. See
[LICENSE](LICENSE), or <https://www.gnu.org/licenses/agpl-3.0.html>.

*A personal music project.*
