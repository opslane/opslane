# TUI renderer verdict

- **Status:** SUPERSEDED (2026-08-23) — the CLI and its TUI were removed. Originally Accepted (use Ink).
- **Measured:** 2026-07-21
- **Runtime constraint:** Node.js 22
- **Packages compared:** `ink@7.1.1` with `@inkjs/ui@2.0.0`; `@opentui/core@0.4.5`
  with `@opentui/react@0.4.5`

Opslane's interactive CLI should use Ink. OpenTUI is faster to start under Bun, but the measured
release does not run under the CLI's Node 22 runtime, fails on Linux musl under Bun, and installs
almost three times as much dependency data. Ink ran on every Node platform available to the spike,
resized cleanly, and was straightforward to make safe for agent callers.

The implementation must branch on `process.stdout.isTTY` **before importing or starting Ink**. The
non-interactive branch owns stdout and emits only the command's JSON result. The renderer is never
allowed to share stdout with that branch.

## Spike

Both candidates rendered the same screen: a seven-item task list updated every 100 ms, a three-item
framework select, and a second static guidance pane. At fewer than 70 columns, the two panes stack.
The throwaway source used `react@19.2.8`; OpenTUI additionally required `bun@1.3.14` for a successful
native render. All package versions were exact, not ranges.

The spike itself packed to 1,687 bytes (5,206 bytes unpacked) with:

```sh
npm pack --json --pack-destination /tmp .
```

The spike directory was deleted after recording this decision.

## Measurements

The native host was macOS arm64 (Darwin 25.5.0). Node measurements explicitly used the repository's
`/Users/abhishekray/.nvm/versions/node/v22.12.0/bin/node`; Bun was 1.3.14. Docker tests ran as Linux
arm64 on Docker Engine 24.0.2.

### Cold start

Neither candidate package exposes a command-line `bin`. Consequently, the plan's literal
`time npx <pkg>` protocol cannot launch either spike: both `npx --yes ink@7.1.1` and
`npx --yes @opentui/react@0.4.5` exit 1 with `could not determine executable to run`.
The equivalent runnable test cleared npm's cache, then timed three new processes rendering one frame
from the pinned local install:

```sh
npm cache clean --force
/usr/bin/time -p env SPIKE_DURATION_MS=0 FORCE_TUI=1 \
  /Users/abhishekray/.nvm/versions/node/v22.12.0/bin/node src/ink.js >/dev/null
/usr/bin/time -p env SPIKE_DURATION_MS=0 FORCE_TUI=1 \
  bun src/opentui.js >/dev/null
```

| Candidate and runtime |   Runs (seconds) |     Median |
| --------------------- | ---------------: | ---------: |
| Ink, Node 22.12.0     | 0.36, 0.29, 0.27 | **0.29 s** |
| OpenTUI, Bun 1.3.14   | 0.16, 0.16, 0.15 | **0.16 s** |
| OpenTUI, Node 22.12.0 |    did not start |        n/a |

The OpenTUI number is not a Node-to-Node comparison. Under Node 22 it failed while resolving
`react-reconciler/constants`; importing the core without React got as far as renderer creation and
then reported that native FFI was unavailable for the runtime.

### Installed and download size

Each installed-size result came from a fresh temporary prefix containing React and only that
candidate's direct renderer packages. `du -sk <prefix>/node_modules` measured disk use. `npm pack`
measured the direct package tarballs; the sum excludes transitive tarballs, while installed size
includes transitive dependencies.

```sh
npm install --prefix <empty> --no-package-lock --ignore-scripts \
  ink@7.1.1 @inkjs/ui@2.0.0 react@19.2.8
npm install --prefix <empty> --no-package-lock --ignore-scripts \
  @opentui/core@0.4.5 @opentui/react@0.4.5 react@19.2.8
npm pack --pack-destination <empty> <the same direct packages>
```

| Candidate |  Installed `node_modules` |                Direct tarballs |
| --------- | ------------------------: | -----------------------------: |
| Ink       | **23,248 KiB (22.7 MiB)** |  **181,985 bytes (177.7 KiB)** |
| OpenTUI   | **65,356 KiB (63.8 MiB)** | **2,101,348 bytes (2.00 MiB)** |

The OpenTUI install includes a platform-specific native package. Its core tarball alone was
2,053,295 bytes versus 129,722 bytes for Ink.

### Platform results

The container checks copied `package.json` and `src/` into a clean directory, installed there, and
forced a one-frame renderer launch. The representative commands were:

```sh
docker run --rm -v "$PWD:/input:ro" node:22-bookworm-slim sh -lc \
  '<copy spike>; npm install; FORCE_TUI=1 SPIKE_DURATION_MS=0 node src/ink.js'
docker run --rm -v "$PWD:/input:ro" node:22-alpine sh -lc \
  '<copy spike>; npm install; FORCE_TUI=1 SPIKE_DURATION_MS=0 node src/ink.js'
docker run --rm -v "$PWD:/input:ro" oven/bun:1.3.14-debian sh -lc \
  '<copy spike>; bun install; FORCE_TUI=1 SPIKE_DURATION_MS=0 bun src/opentui.js'
docker run --rm -v "$PWD:/input:ro" oven/bun:1.3.14-alpine sh -lc \
  '<copy spike>; bun install; FORCE_TUI=1 SPIKE_DURATION_MS=0 bun src/opentui.js'
```

| Platform          | Ink on Node 22                               | OpenTUI on Node 22      | OpenTUI on Bun 1.3.14   |
| ----------------- | -------------------------------------------- | ----------------------- | ----------------------- |
| macOS arm64       | pass                                         | fail before first frame | pass                    |
| Linux glibc arm64 | pass (`node:22-bookworm-slim`, Node 22.23.1) | fail before first frame | pass                    |
| Linux musl arm64  | pass (`node:22-alpine`, Node 22.23.1)        | fail before first frame | fail before first frame |
| Windows           | not measured                                 | not measured            | not measured            |

The Linux musl OpenTUI failure was
`Error relocating .../core-linux-arm64/libopentui.so: getcontext: symbol not found`. Explicitly
installing `@opentui/core-linux-arm64-musl@0.4.5` did not fix the resolver: it still requested the
glibc `@opentui/core-linux-arm64` package.

Windows was not available through the local Linux-container Docker daemon, and this spike did not
create an external CI run. The published OpenTUI metadata includes Windows native optional packages,
but that is not execution evidence. Run the equivalent one-frame commands on a Windows CI runner
before making any future Windows support claim.

### Piped-output hard gate

The non-TTY guard was tested through a real pipe:

```sh
node src/ink.js | cat > /tmp/ink.out
bun src/opentui.js | cat > /tmp/opentui.out
LC_ALL=C awk 'BEGIN{esc=sprintf("%c",27)} index($0,esc){found=1} \
  END{print(found ? "ANSI" : "clean")}' /tmp/ink.out /tmp/opentui.out
```

Both guarded commands contained zero escape bytes. The Ink branch emitted 46 bytes of JSON and the
OpenTUI branch emitted 50. This proves the guard, not that either renderer is safe to invoke in agent
mode. With `FORCE_TUI=1`, Ink wrote 1,206 bytes of screen text without escapes (still invalid as the
command's single JSON result), while OpenTUI wrote 4,810 bytes including ANSI terminal-control
sequences. The pre-render branch is therefore mandatory even with Ink.

### Resize

Each native macOS run started at 80 columns. After 350 ms, its controlling pseudo-terminal was
changed to 40 columns while list updates continued:

```sh
script -q /tmp/resize.typescript zsh -c \
  'term_device=$(tty); stty -f "$term_device" cols 80 rows 24;
   (sleep 0.35; stty -f "$term_device" cols 40 rows 30) &
   SPIKE_DURATION_MS=1000 <runtime> src/<candidate>.js'
```

Ink's `useWindowSize()` and OpenTUI's `useTerminalDimensions()` both triggered a clean reflow. At 40
columns the panes stacked, borders closed correctly, task updates continued in place, and neither
capture showed stale fragments or broken control sequences. No corruption was observed. OpenTUI's
musl and Node failures prevented a resize test in those environments.

## Ergonomics

**Ink.** The API matches the CLI's existing Node/React/ESM toolchain: `Box` and `Text` compose the
layout, `@inkjs/ui` supplies the select, and `useWindowSize()` makes responsive layout explicit.
The first spike accidentally read the wrong dimension name (`width` rather than `columns`), which
the resize capture exposed immediately; after correction, the stacked layout was small and clear.
The main integration burden is architectural rather than visual: keep the TTY decision outside the
component tree so interactive hooks are never mounted for piped callers.

**OpenTUI.** Its intrinsic elements, built-in select, native flex layout, and
`useTerminalDimensions()` produced a concise component tree, and its Bun startup was the fastest.
However, the React package could not be loaded by the repository's Node runtime, the core depends on
platform-native binaries, and musl resolution failed even under Bun. Adopting it would therefore
also mean changing Opslane's runtime/distribution model and expanding the platform matrix, which is
far more work and risk than the screen warrants.

## Consequences

- Add `ink@7.1.1` and `@inkjs/ui@2.0.0` when the production TUI is implemented; do not use version
  ranges without repeating this measurement.
- Preserve a renderer-free, byte-clean JSON path whenever stdout is not a TTY.
- Use `useWindowSize().columns` for the 70-column responsive breakpoint.
- Do not add OpenTUI or Bun to the CLI for this work.
- Windows remains an explicit verification gap; this decision does not claim it was tested.
