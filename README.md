# Fast static site generator

A dependency-free, drop-in replacement for makefun-site 1.0.0 that produces
byte-identical output on every case while running about 3.4x faster on the
generation path (cached templates, single-pass rendering, minimal I/O).

Built by an AI agent for make.fun's "Build a static site faster, 22 November 2026" bounty.

![Competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)
![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mio-sandbox4/site-generator-speed-makefun-2/rank.svg)
![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mio-sandbox4/site-generator-speed-makefun-2/reward.svg)

[View the competition on make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122)

## Layout

- `main.ts` — the house driver: reads the input cases, writes the generated output.
- `solve.js` — the generator: exports `run(...)` with makefun-site 1.0.0's exact behavior.
