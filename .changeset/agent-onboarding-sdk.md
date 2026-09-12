---
"@opslane/sdk": minor
---

Agent-driven onboarding support: `endpoint` accepts a same-origin path such as `/opslane` for a Next.js rewrite tunnel, SDK requests send `credentials: 'omit'`, and the new `opslane-sourcemaps` post-build command stamps debug IDs, uploads, and strips source maps for Next.js and other bundlers.
