# CLI agent contract

This deterministic reference is sourced from `cli/src/contract.ts` and the setup protocol in `cli/src/setup.ts`. It covers the agent-facing `setup`, `snippet`, `verify`, `status`, and `sourcemaps install-plugin` commands, and `onboard` when invoked non-interactively.

## Output and persistence invariants

- Each covered command writes exactly one JSON document to stdout per invocation. It never mixes prose, progress, or a second JSON document into stdout. `onboard` is covered only on its non-TTY path, which emits `tty_required` and exits 1; under a TTY it is an interactive human command and, like `login` and `init`, is exempt.
- `sourcemaps install-plugin` emits one terminal JSON document. Its interactive
  preview and prompt use the terminal before that document; non-TTY, `--json`,
  `--yes`, and `--check` never mix prose into stdout.
- Diagnostics go to stderr. Blocking `setup` writes the interim `auth_required` document, including the human authorization URL, to stderr and reserves stdout for its one terminal document. `setup --start` instead returns `auth_required` as its terminal stdout document.
- `auth_required`, `pending`, an informational `already_configured`, `completed`, `ok`, and `configured` exit 0. Failures and usage errors exit 1. A refused `setup --force` is the documented exception where `already_configured` exits 1 because the repo already has a project.
- `login` and `init` are interactive human commands and are exempt from this JSON/stream contract.
- Poll requests send the secret only in the `X-Opslane-Poll-Token` header. A missing or incorrect token is indistinguishable from an unknown poll ID: both produce `not_found`.
- The canonical origin is the lowercased URL scheme and host, with default port 80 or 443 removed and all path, query, fragment, and trailing slash content discarded. Credentials and login tokens never cross canonical origins.
- Pending sessions, credentials, and origin-scoped login tokens are written through a unique temporary file followed by rename. The final local file mode is 0600.

## Canonical terminal statuses

The rows between the markers are machine parsed. Do not edit them without changing `AGENT_STATUSES` in `cli/src/contract.ts` in the same change.

<!-- BEGIN AGENT_STATUS_CONTRACT -->
| Command | Status | Exit code | Stream | Meaning |
| --- | --- | ---: | --- | --- |
| `setup --start` | `auth_required` | 0 | `stdout` | The session was created and the human authorization URL is ready. |
| `setup` | `already_configured` | 0 | `stdout` | This repo already has valid credentials or is already configured. |
| `setup --force` | `already_configured` | 1 | `stdout` | The server refused a replacement key; run onboard for the existing project instead. |
| `setup --poll` | `pending` | 0 | `stdout` | Authorization or provisioning is still in progress when polling times out. |
| `setup` | `completed` | 0 | `stdout` | Provisioning completed and the API key was stored locally. |
| `setup --poll` | `not_found` | 1 | `stdout` | The poll session is unknown or the poll token did not match. |
| `setup --poll` | `expired` | 1 | `stdout` | The setup session expired and a new session is required. |
| `setup` | `rate_limited` | 1 | `stdout` | The setup endpoint rejected the request until its retry interval elapses. |
| `setup --poll` | `failed` | 1 | `stdout` | Provisioning reached a definitive server-side failure. |
| `setup --poll` | `key_unavailable` | 1 | `stdout` | Provisioning completed but the API-key delivery window has closed. |
| `setup` | `api_unreachable` | 1 | `stdout` | The configured Opslane API could not be reached within the operation window. |
| `setup` | `internal_error` | 1 | `stdout` | The server response was malformed, unknown, or an internal failure. |
| `setup` | `usage_error` | 1 | `stdout` | The command-line arguments are invalid or mutually exclusive. |
| `snippet, verify, status, errors` | `usage_error` | 1 | `stdout` | The selected API URL is not a valid HTTP(S) origin. |
| `setup` | `credentials_invalid` | 1 | `stdout` | Stored credentials were rejected and must be replaced by re-onboarding. |
| `setup` | `repo_not_detected` | 1 | `stdout` | No GitHub owner/repo could be resolved from the arguments or git remote. |
| `onboard` | `tty_required` | 1 | `stdout` | The command needs an interactive terminal; run it without piping stdin or stdout. |
| `snippet, verify, status, errors` | `no_credentials` | 1 | `stdout` | No credential matches the current API origin and repository. |
| `snippet` | `internal_error` | 1 | `stdout` | Framework detection or patch generation failed before a snippet could be emitted. |
| `verify` | `ok` | 0 | `stdout` | The API is reachable; has_events says whether the first event arrived. |
| `verify` | `error` | 1 | `stdout` | Connection verification failed after credentials were resolved. |
| `status` | `configured` | 0 | `stdout` | Credentials for the current API origin and repository are configured. |
| `sourcemaps install-plugin` | `consent_required` | 1 | `stdout` | The proposed edit and disclosure are ready, but explicit consent is required before writing. |
| `sourcemaps install-plugin` | `edited` | 0 | `stdout` | The Vite config was edited, reread, resolved, and the Opslane plugin was registered. |
| `sourcemaps install-plugin` | `usage_error` | 1 | `stdout` | The command-line arguments are invalid or mutually exclusive. |
| `sourcemaps install-plugin [--check]` | `already_wired` | 0 | `stdout` | The resolved Vite plugin list already contains the Opslane plugin. |
| `sourcemaps install-plugin` | `unsupported` | 1 | `stdout` | The config shape cannot be edited safely; follow the returned manual completion path. |
| `sourcemaps install-plugin` | `legacy_opslane_plugin` | 1 | `stdout` | The config uses the legacy Opslane plugin and must be migrated instead of double-registered. |
| `sourcemaps install-plugin` | `config_not_found` | 1 | `stdout` | No Vite config was found in the selected app directory. |
| `sourcemaps install-plugin` | `multiple_configs` | 1 | `stdout` | Several Vite configs were found and the command refuses to guess. |
| `sourcemaps install-plugin` | `unsafe_config` | 1 | `stdout` | The selected config escapes the repository or is not a safe regular file. |
| `sourcemaps install-plugin` | `vite_not_installed` | 1 | `stdout` | The selected app has no resolvable Vite installation. |
| `sourcemaps install-plugin` | `vite_version_unsupported` | 1 | `stdout` | The installed Vite version is below the supported major-version floor. |
| `sourcemaps install-plugin` | `sdk_not_installed` | 1 | `stdout` | The selected app has no resolvable Opslane SDK installation. |
| `sourcemaps install-plugin` | `plugin_not_available_yet` | 1 | `stdout` | The installed SDK does not yet satisfy the frozen Vite plugin contract. |
| `sourcemaps install-plugin` | `vite_config_broken_before_edit` | 1 | `stdout` | The original Vite config failed to resolve, so nothing was written. |
| `sourcemaps install-plugin` | `vite_config_parse_failed` | 1 | `stdout` | The written config did not parse and the original file was restored. |
| `sourcemaps install-plugin` | `vite_config_structure_mismatch` | 1 | `stdout` | The reread config did not contain the expected structure and the original file was restored. |
| `sourcemaps install-plugin` | `vite_plugin_not_registered` | 1 | `stdout` | The resolved config omitted the Opslane plugin; any command edit was restored. |
| `sourcemaps install-plugin` | `vite_config_broken_after_edit` | 1 | `stdout` | The edited Vite config failed to resolve and the original file was restored. |
| `sourcemaps install-plugin` | `vite_config_resolve_timeout` | 1 | `stdout` | Post-edit Vite resolution timed out, the child stopped, and the original file was restored. |
| `sourcemaps install-plugin` | `config_changed_before_write` | 1 | `stdout` | The config changed after preview, so the command refused to overwrite it. |
| `sourcemaps install-plugin` | `repo_changed_during_verification` | 1 | `stdout` | Config execution changed another repository path; the command stopped and restored its edit. |
| `sourcemaps install-plugin` | `write_failed` | 1 | `stdout` | The atomic config write failed and the original file was restored. |
| `sourcemaps install-plugin` | `restore_failed` | 1 | `stdout` | The original config could not be restored; recovery details and a backup path are reported. |
<!-- END AGENT_STATUS_CONTRACT -->

## `sourcemaps install-plugin`

`--config <path>` selects a nonstandard config, `--app-dir <path>` selects the
app in a monorepo, `--yes` applies after deterministic checks without prompting,
`--json` returns the proposal without prompting, and `--check` only resolves the
config and verifies registration. `--check` never writes.

Without a terminal and without `--yes`, the command returns
`consent_required` with `file`, `diff`, `disclosure`, and `warnings`, exits 1,
and writes nothing. A tool must show the disclosure to a human before retrying
with `--yes`.

The command treats exit 1 as a terminal result, including safe refusals and
restored verification failures. Source maps are optional to error capture:
onboarding S7 must surface the returned remediation but treat exit 1 from this
command as non-fatal and continue. `restore_failed` is the exception that needs
immediate attention because the selected config may still contain the attempted
edit; its JSON includes `restoreFailures` and `recoveryPath`.

## `setup`

| Status | Cause | JSON fields beyond `status` | Exit | Retry rule |
| --- | --- | --- | ---: | --- |
| `auth_required` | `POST /api/v1/agent/setup` returns HTTP 201 | `auth_url: string`, `poll_id: UUID`, `poll_token: string`, `message: string` | 0 | Show `auth_url` to the human, then call `setup --poll <poll_id>`. |
| `already_configured` | Valid local credentials, or setup returns HTTP 200 for an existing server project | `repo?: string`, `message?: string`, `remediation?: string` | 0 normally; 1 after refused `--force` | Ordinary setup is done. A refused force attempt requires `opslane onboard`. |
| `pending` | Poll returns HTTP 200 pending until `--timeout` elapses | `poll_id: UUID`, `message: string` | 0 | Keep the pending file and call `setup --poll <poll_id>` again. |
| `completed` | Poll returns HTTP 200 completed with `api_key` | `repo: string`, `org_id: string`, `project_id: string`, `api_key: string` | 0 | Do not retry. The credential is already stored. |
| `not_found` | Poll returns HTTP 404 for unknown ID or missing/incorrect token | `message?: string`, `remediation?: string` | 1 | Delete stale pending state and start a new setup session. |
| `expired` | Poll returns HTTP 410 | `message?: string`, `remediation: string` | 1 | Start a new setup session. |
| `rate_limited` | Initial setup returns HTTP 429 | `retry_after: number`, `message?: string` | 1 | Wait `retry_after` seconds, preferring the server body then the `Retry-After` header, and retry. Poll-time 429 is retried internally. |
| `failed` | Poll returns HTTP 200 with a definitive `failure_reason` | `failure_reason: string`, `message?: string` | 1 | Apply the failure-specific remediation, then start a new session if appropriate. |
| `key_unavailable` | Poll returns completed without `api_key` after the delivery window | `project_id?: string`, `remediation: string` | 1 | Run `opslane onboard` in this repo; do not re-run unauthenticated setup. |
| `api_unreachable` | Network attempts fail until the operation window closes | `api_url: string`, `message?: string` | 1 | Check the origin/network and retry. |
| `internal_error` | Malformed JSON, unknown server status, or server internal error | `message: string`, `server_status?: unknown` | 1 | Retry only if transient; otherwise report the response shape. |
| `usage_error` | Conflicting modes, invalid UUID, invalid timeout, or invalid API URL | `message: string` | 1 | Correct the invocation; do not retry unchanged. |
| `credentials_invalid` | Existing credential validation returns HTTP 401 or 403 | `remediation: string` | 1 | Use `--force` only for a repo without a server project; otherwise run `opslane onboard`. |
| `repo_not_detected` | Neither `--repo`/`--repo-url` nor the git origin resolves to GitHub `owner/repo` | `message: string` | 1 | Run inside a clone with an origin remote or pass the repo explicitly. |

Definitive setup failure reasons currently passed through from the server are `identity_unverified`, `installation_not_yours`, `repo_not_granted`, `org_exists_needs_invite`, and `repo_already_configured`. GitHub callback errors that cannot prove identity remain pending and require reopening the same authorization URL; they do not create a sixth definitive reason.

## `snippet`

| Result | Cause | JSON schema | Exit | Retry rule |
| --- | --- | --- | ---: | --- |
| Success | Matching credentials and a supported or fallback framework | `{framework: string, install: string, patches: Patch[], env?: {var: string, value: string, file: string, gitignore: true}}` | 0 | Do not retry; apply the returned install command, patches, and env write. |
| `no_credentials` | No credential matches the current origin and repo | `{status: "no_credentials", message: string}` | 1 | Run setup in this repo, then retry. |
| `internal_error` | Framework detection or patch generation fails | `{status: "internal_error", message: string}` | 1 | Fix the reported local file/framework error, then retry. |
| `usage_error` | `--api-url` is not a valid HTTP(S) URL | `{status: "usage_error", message: string}` | 1 | Correct the URL; do not retry unchanged. |

`Patch` is `{file_path: string, action: string, content?: string, insert_after?: string, insert_content?: string}`. A non-hosted credential causes generated initialization to include its canonical origin as `endpoint`.

## `verify`

| Status | Cause | JSON fields beyond `status` | Exit | Retry rule |
| --- | --- | --- | ---: | --- |
| `ok` | Health check succeeds; the event-count request may or may not report an event | `api_reachable: true`, `has_events: boolean`, `message: string` | 0 | If `has_events` is false, trigger a test error and retry after ingestion. |
| `error` | Health or authenticated verification fails after credentials resolve | `api_reachable: boolean`, `has_events: false`, `message: string` | 1 | Check the reported connection failure, then retry. |
| `no_credentials` | No credential matches the current origin and repo | `message: string` | 1 | Run setup in this repo, then retry. |
| `usage_error` | `--api-url` is not a valid HTTP(S) URL | `message: string` | 1 | Correct the URL; do not retry unchanged. |

## `status`

| Status | Cause | JSON fields beyond `status` | Exit | Retry rule |
| --- | --- | --- | ---: | --- |
| `configured` | A credential matches the current canonical origin and repo | `org_id: string`, `project_id: string`, `repo: string`, `api_url: string` | 0 | Do not retry. |
| `no_credentials` | No credential matches the current canonical origin and repo | `message: string` | 1 | Run setup in this repo, then retry. |
| `usage_error` | `--api-url` is not a valid HTTP(S) URL | `message: string` | 1 | Correct the URL; do not retry unchanged. |
