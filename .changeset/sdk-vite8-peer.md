---
'@opslane/sdk': patch
---

Accept Vite 8 as a peer. The range was `^6 || ^7`, so installing the SDK into a Vite 8 project failed with `ERESOLVE` before anything else could run.
