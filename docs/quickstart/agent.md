---
draft: true
covers:
  - cli/src/index.ts
  - cli/src/setup.ts
  - cli/src/snippet.ts
  - cli/src/verify.ts
  - cli/src/status.ts
  - cli/src/contract.ts
  - cli/src/agent-credentials.ts
  - cli/src/pending.ts
  - packages/ingestion/handler/agent_setup.go
  - packages/ingestion/handler/routes.go
  - packages/sdk/src/config.ts
---
# Agent quickstart

This page is for **coding agents** (and the humans supervising them) setting up Opslane in a repository. Every command below — `setup`, `snippet`, `verify`, `status` — prints exactly one JSON document on stdout; diagnostics go to stderr. `opslane login` is an interactive human command and is not part of this flow. The full status and exit-code table is the [CLI agent contract](https://docs.opslane.com/reference/cli-agent-contract/).

One human interaction is required and cannot be skipped: a person must authorize the GitHub App. Everything else is yours.

## 1. Start a setup session

Run from the repository root (a git `origin` remote pointing at GitHub is required for repo detection; otherwise pass `--repo owner/name`):

```bash
npx -y @opslane/cli@latest setup --start
```

```json
{
  "status": "auth_required",
  "auth_url": "https://api.opslane.com/agent/auth/6f0c…",
  "poll_id": "6f0c…",
  "poll_token": "<secret — store locally, never print or commit>",
  "message": "Authorize Opslane: https://api.opslane.com/agent/auth/6f0c…"
}
```

If the repo already has an Opslane project, you get `{"status": "already_configured", …}` instead — see the table below.

Self-hosting? Add `--api-url http://localhost:8082` to every command on this page. Note the agent flow needs a configured GitHub App on your server ([connecting GitHub](https://docs.opslane.com/guides/github-app/)); the default Compose stack from the [self-host quickstart](https://docs.opslane.com/quickstart/self-host/) does not include one.

## 2. Hand the auth link to your human

Show `auth_url` to your human **verbatim** and ask them to open it in a browser where they are signed in to GitHub. They will see one combined GitHub screen that installs the Opslane App and authorizes their identity. The session expires about 15 minutes after `setup --start`.

## 3. Poll until provisioned

```bash
npx -y @opslane/cli@latest setup --poll <poll_id>
```

- `{"status": "pending", …}` — the human hasn't finished (or the org requires installation approval). Exit code 0. Run the poll again; remind the human about the link if it persists.
- `{"status": "completed", "org_id": "…", "project_id": "…", "api_key": "…"}` — provisioned. The credential is stored locally (`~/.opslane/agent-credentials.json`, mode 0600). Do not echo `api_key` into logs, chat, or commits.

If the human reports an error page that says to **reopen the authorization link**, that is a transient GitHub-side hiccup, not a failure: the session is still `pending` — have them open the same `auth_url` again and keep polling. (Only `pending` sessions can be reopened; the `failed` states in the table below always need a fresh `setup --start`.)

## 4. Wire the SDK

```bash
npx -y @opslane/cli@latest snippet
```

The JSON response has three parts — apply all three:

1. `install` — the package-manager-specific install command for `@opslane/sdk`. Run it first.
2. `patches` — each with `file_path`, an `action`, and content/anchor fields (for example `insert_after` + `insert_content`). Apply exactly as printed.
3. `env` — `{var, value, file, gitignore}`. Write the variable to the named file (typically `.env.local`) and make sure that file is gitignored.

## 5. Tell your human about session replay

Opslane records session replay **by default** so investigations can see what the user did before an error. Surface this to your human before shipping: replay is masked by default and can be tuned or disabled — point them at [replay privacy and masking](https://docs.opslane.com/guides/replay-privacy/). Do not silently make this decision for them.

## 6. Trigger an error and verify

Cause any handled or unhandled error in the running app (a test route, a dev-only crash button), then:

```bash
npx -y @opslane/cli@latest verify
```

`{"status": "ok", "api_reachable": true, "has_events": true}` means the loop is closed: Opslane is receiving events for this project. `has_events: false` with `status: "ok"` means the API is reachable but no event has arrived yet — trigger the error again and re-run.

## Failure and edge states

Where each state comes from and what to do. (`rate_limited` comes from `setup --start`; the CLI retries poll-time rate limits internally. `key_unavailable` is reported by the CLI after a *completed* poll whose key-delivery window closed. The rest are poll or start results as noted.)

| Response | Emitted by | Meaning | What the agent should do |
| --- | --- | --- | --- |
| `status: "already_configured"` (exit 0) | `setup` / `setup --start` | Either valid local credentials exist for this repo, or the server already has a project for it. | If you have local credentials, run `verify`. If `verify` says `no_credentials`, recovery needs the human: run `opslane onboard` in this repo. |
| `status: "expired"` | `setup --poll` | The ~15-minute session lapsed before authorization. | Run `setup --start` again and hand over the fresh link. |
| `status: "not_found"` | `setup --poll` | Unknown `poll_id` or wrong poll token. | Run `setup --start` again. |
| `status: "rate_limited"` | `setup --start` | Too many session starts. | Wait `retry_after` seconds, then retry. |
| `status: "key_unavailable"` | `setup --poll` | Provisioning completed but the key-delivery window closed. | Recovery needs the human: run `opslane onboard` in this repo. |
| `status: "failed", failure_reason: "identity_unverified"` | `setup --poll` | GitHub couldn't prove the authorizing human's identity (for example no verified email). | Human fixes their GitHub account state; then a fresh `setup --start`. |
| `status: "failed", failure_reason: "installation_not_yours"` | `setup --poll` | The person who authorized doesn't own the App installation used. | The same human must both install and authorize; fresh `setup --start`. |
| `status: "failed", failure_reason: "repo_not_granted"` | `setup --poll` | The installation doesn't include this repository. | Human grants the repo in the installation's repository access first; then a fresh `setup --start` (failed sessions cannot be reopened). |
| `status: "failed", failure_reason: "org_exists_needs_invite"` | `setup --poll` | The org already exists in Opslane and the human isn't a member. | An existing org admin invites them in the dashboard; then a fresh `setup --start`. |
| `status: "failed", failure_reason: "repo_already_configured"` | `setup --poll` | Another project already owns this repository. | Use the existing project: run `opslane onboard` in this repo. |

## Raw HTTP (no CLI)

The CLI is a thin client over two endpoints — usable directly if you cannot run `npx`. `repo_url` takes **`owner/repo` format** (a full GitHub URL is rejected with 400):

```bash
curl -s -X POST https://api.opslane.com/api/v1/agent/setup \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "OWNER/REPO", "agent_name": "my-agent"}'
# → 201 {"status":"auth_required","auth_url":…,"poll_id":…,"poll_token":…}

curl -s https://api.opslane.com/api/v1/agent/poll/<poll_id> \
  -H "X-Opslane-Poll-Token: <poll_token>"
# → 200 {"status":"pending"} … then {"status":"completed","api_key":…}
```

The poll token is the retrieval secret — send it only in the `X-Opslane-Poll-Token` header, never in a URL. Completed polls redeliver the key until the session expires; treat every delivery as the same secret.
