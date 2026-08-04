---
'@opslane/sdk': major
---

Remove the legacy `opslaneSourceMapPlugin` export. It had been a hard-fail stub since the key split; `opslane()` now uploads source maps itself when `OPSLANE_SOURCEMAP_KEY` and `OPSLANE_ENDPOINT` are set. Configs importing the old name fail at build time with a missing-export error; run `opslane sourcemaps install-plugin` to migrate.
