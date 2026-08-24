# S6a uses a host codemod and config resolution

- **Status:** SUPERSEDED (2026-08-23) — the CLI codemod was removed.
- **Supersedes for S6a:** `docs/design/2026-07-29-keys-sourcemaps-onboarding.md` §5.8.
- **Evidence:** the 70-config corpus recorded in
  `docs/design/2026-07-30-s6a-vite-plugin-onboarding.md`.

S6a reverses two choices from the parent onboarding design.

## The host writes the edit

The earlier design assigned Vite-config editing to a model. A measured
TypeScript-AST codemod safely edits 64 of 70 configs; the model prototype edited
18. The host implementation also makes the exact offsets, refusal reasons,
idempotence, and byte-for-byte rollback testable without executing customer
code.

The model remains out of this path. Unsupported shapes produce a typed refusal
and a manual completion path.

## Verification resolves the config

The earlier design used a production build as proof. Section 5.4 requires the
source-map plugin not to fail a customer's build when upload fails, so a green
build does not prove the plugin loaded or registered. Builds also mix in
unrelated type-check and application failures.

The command instead asks the customer's installed Vite to `resolveConfig` for a
build and asserts that the resolved plugin list contains the frozen plugin name.
This executes the relevant plugin setup while avoiding a full production build.
The execution boundary and its residual risk are recorded in
`docs/decisions/vite-config-execution.md`.

