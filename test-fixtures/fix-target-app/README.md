# Fix verification target

This disposable fixture plants an identity-vs-position bug in
`src/selection.ts`, inside `rebuildSelection`: rebuilding a reordered options
list selects its first entry instead of preserving the selected option ID.

The checked-in base suite passes. A valid agent fix must add a regression test
whose distinctive assertion fails on this base commit and passes after the
implementation preserves identity. CP2 copies this directory into a temporary
Git repository before running the real local sandbox harness.
