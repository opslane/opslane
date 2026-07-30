# Vite config execution is allowed in a killable child process

- **Status:** ACCEPTED (2026-07-30).
- **Applies to:** `opslane sourcemaps install-plugin`.
- **Prompted by:** `docs/design/2026-07-30-s6a-vite-plugin-onboarding.md`.

The onboarding agent is denied a shell in `cli/src/onboard/policy.ts`. That
boundary remains unchanged. The source-map installer is deterministic host code,
but verifying its edit requires Vite to evaluate the customer's config and every
module that config imports.

The command may run that evaluation in a forked child process using the
customer's installed Vite. The parent removes Opslane, Anthropic, GitHub, AWS,
and npm-token environment variables, imposes a timeout, escalates from `SIGTERM`
to `SIGKILL`, and waits for the child to exit before restoring the config.

## What this does and does not provide

A fork is not a sandbox. The child retains filesystem and network access. In
particular, removing environment variables does not prevent code from reading
`~/.opslane/credentials.json` or `~/.opslane/agent-credentials.json`. The fork
only gives the host a controlled environment and a process it can stop before
the same file is restored.

This is accepted because a developer explicitly runs the tool on their own
repository, after the command discloses that it will execute the config. The
command does not use this capability during model-driven onboarding and does not
expand the agent's tool policy.

## Consequences

- Resolve the config before editing so an existing failure is not attributed to
  the command.
- Resolve it again after editing and require the frozen plugin name.
- Never restore while the child may still be running.
- Do not describe the child as isolated or credential-free.

