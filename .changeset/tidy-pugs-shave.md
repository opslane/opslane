---
'@opslane/sdk': patch
---

Publish readiness. SDK type declarations are now bundled into flat per-entry files, inlining types from the private `@opslane/shared` package — previously the published tarball's types were unresolvable for npm consumers. CLI tarball now ships only `dist` and carries repository metadata required for npm provenance.
