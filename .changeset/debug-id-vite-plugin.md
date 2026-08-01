---
'@opslane/sdk': minor
---

Stamp Vite builds with deterministic debug IDs and carry them into error events.

`opslaneVitePlugin()` (exported as `opslane`) computes an ID from each source
map, writes it to the map's `debugId` field and the chunk's `//# debugId=`
footer, and registers the runtime chunk URL. The SDK matches stack-frame URLs
against that registry and attaches exact matches as `debug_meta.images`. The
raw stack is always preserved.

The plugin name is exported as `OPSLANE_VITE_PLUGIN_NAME` so tooling can detect
the plugin without copying the string.

By default the plugin requests hidden source maps and removes them from the
build output. Set `sourcemaps: 'keep'` to retain them.

Verified against Vite 5, 6, 7, and 8.
