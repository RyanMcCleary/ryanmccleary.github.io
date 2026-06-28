# Othello move sounds

The app now ships just two source samples and performs all board-position
variations in real time with the Web Audio API:

- `player.wav` — a bell-like chime used for human moves.
- `computer.wav` — a distorted guitar power-chord sample used for engine moves.

Both are derived from the same public-domain / CC0 sources as before:

- Guitar source samples: `cluesurf/wavebase`, public-domain WAV files from
  `base/guitar/stratocaster`.
- Computer move guitar source: "Distortion Guitar Power Chord E.wav" by tosha73,
  licensed under Creative Commons Attribution 4.0, from Freesound:
  https://freesound.org/people/tosha73/sounds/533847/
- Bell reference: FreePats Tubular Bells, CC0, from the Versilian Community
  Sample Library.

## How the variations are made

For each played/flipped square the code creates a Web Audio graph:

- **Pitch** is shifted by `playbackRate` so higher board rows play higher notes
  (a just-intonation major scale, row 3 being the source pitch).
- **Tone color** is changed with a resonant lowpass filter: left-side columns
  are darker/smoother, right-side columns are brighter and more driven.
- **Stereo position** is panned from left (column a) to right (column h).
- A **dynamics compressor** prevents clipping when many discs flip at once.
- A simple amplitude envelope gives each hit a natural decay.

This keeps the entire sound asset budget under 200 KB instead of ~19 MB.
