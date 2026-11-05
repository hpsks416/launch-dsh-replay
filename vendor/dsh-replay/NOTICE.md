# Vendored upstream: @mingozhou/dsh-replay 0.4.2

- Package: `@mingozhou/dsh-replay`
- Version: `0.4.2` (published 2026-10-20)
- License: MIT (see `LICENSE` in this directory)
- Upstream: https://github.com/MingoZhou/dsh-replay
- Vendored files (unmodified copies):
  - `core.js`  ← upstream `lib/core.js` — dependency-free parser/timeline/audit core
  - `viewer.js` ← upstream `lib/viewer.js` — standalone offline viewer bundle (React inlined)

Why vendored: the desktop launcher must render DSH **session v4** logs offline,
without pnpm/network and without a running DSH. Upstream exposes the same viewer
through its own "Export HTML" action; this project reuses the exported bundle and
the `window.__DSHR_DATA__ = { sessions: [{ header, events, title }] }` contract
(the template mirrors upstream `buildReplayHtml`).

Our wrapper code lives in `../../lib/` and `../../*.mjs`; nothing in this
directory was modified. To update: copy `lib/core.js` and `lib/viewer.js` from a
newer upstream release and re-run the smoke test (`node ../../render.mjs --list`).

Attribution overlay (added in launch-dsh-replay 1.1.1): the viewer bundle
hard-codes upstream repository links and the "dsh-replay" brand. We keep these
files byte-identical and rewrite only the generated HTML at export time
(`../../lib/sessions.mjs` → `applyAttributionOverlay`): repository links point at
this project (`github.com/hpsks416/launch-dsh-replay`) and the footer keeps the
explicit engine credit "@mingozhou/dsh-replay (MIT)".
