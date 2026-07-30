/**
 * Canonical terminal-state contract for commands intended to be consumed by
 * coding agents. Keep the table in docs/reference/cli-agent-contract.md in
 * exact sync; contract-drift.test.ts and the repository docs check enforce it.
 *
 * A status may have more than one variant when its exit code is contextual.
 * In particular, an informational `already_configured` result succeeds, while
 * `setup --force` uses the same server status with exit 1 when the server
 * refuses to mint a replacement key.
 */
export interface AgentStatusContract {
  command: string;
  status: string;
  exitCode: 0 | 1;
  stream: 'stdout' | 'stderr';
  meaning: string;
}

function agentStatus<
  const Command extends string,
  const Status extends string,
  const ExitCode extends 0 | 1,
  const Stream extends 'stdout' | 'stderr',
  const Meaning extends string,
>(
  command: Command,
  status: Status,
  exitCode: ExitCode,
  stream: Stream,
  meaning: Meaning,
) {
  return { command, status, exitCode, stream, meaning } as const;
}

// Keep each call on one line: scripts/check-docs-drift.mjs reads these tuples
// without requiring a TypeScript build before `pnpm docs:check`.
export const AGENT_STATUSES = [
  agentStatus("setup --start", "auth_required", 0, "stdout", "The session was created and the human authorization URL is ready."),
  agentStatus("setup", "already_configured", 0, "stdout", "This repo already has valid credentials or is already configured."),
  agentStatus("setup --force", "already_configured", 1, "stdout", "The server refused a replacement key; run onboard for the existing project instead."),
  agentStatus("setup --poll", "pending", 0, "stdout", "Authorization or provisioning is still in progress when polling times out."),
  agentStatus("setup", "completed", 0, "stdout", "Provisioning completed and the API key was stored locally."),
  agentStatus("setup --poll", "not_found", 1, "stdout", "The poll session is unknown or the poll token did not match."),
  agentStatus("setup --poll", "expired", 1, "stdout", "The setup session expired and a new session is required."),
  agentStatus("setup", "rate_limited", 1, "stdout", "The setup endpoint rejected the request until its retry interval elapses."),
  agentStatus("setup --poll", "failed", 1, "stdout", "Provisioning reached a definitive server-side failure."),
  agentStatus("setup --poll", "key_unavailable", 1, "stdout", "Provisioning completed but the API-key delivery window has closed."),
  agentStatus("setup", "api_unreachable", 1, "stdout", "The configured Opslane API could not be reached within the operation window."),
  agentStatus("setup", "internal_error", 1, "stdout", "The server response was malformed, unknown, or an internal failure."),
  agentStatus("setup", "usage_error", 1, "stdout", "The command-line arguments are invalid or mutually exclusive."),
  agentStatus("snippet, verify, status, errors", "usage_error", 1, "stdout", "The selected API URL is not a valid HTTP(S) origin."),
  agentStatus("setup", "credentials_invalid", 1, "stdout", "Stored credentials were rejected and must be replaced by re-onboarding."),
  agentStatus("setup", "repo_not_detected", 1, "stdout", "No GitHub owner/repo could be resolved from the arguments or git remote."),
  agentStatus("onboard", "tty_required", 1, "stdout", "The command needs an interactive terminal; run it without piping stdin or stdout."),
  agentStatus("snippet, verify, status, errors", "no_credentials", 1, "stdout", "No credential matches the current API origin and repository."),
  agentStatus("snippet", "internal_error", 1, "stdout", "Framework detection or patch generation failed before a snippet could be emitted."),
  agentStatus("verify", "ok", 0, "stdout", "The API is reachable; has_events says whether the first event arrived."),
  agentStatus("verify", "error", 1, "stdout", "Connection verification failed after credentials were resolved."),
  agentStatus("status", "configured", 0, "stdout", "Credentials for the current API origin and repository are configured."),
  agentStatus("sourcemaps install-plugin", "consent_required", 1, "stdout", "The proposed edit and disclosure are ready, but explicit consent is required before writing."),
  agentStatus("sourcemaps install-plugin", "edited", 0, "stdout", "The Vite config was edited, reread, resolved, and the Opslane plugin was registered."),
  agentStatus("sourcemaps install-plugin", "usage_error", 1, "stdout", "The command-line arguments are invalid or mutually exclusive."),
  agentStatus("sourcemaps install-plugin [--check]", "already_wired", 0, "stdout", "The resolved Vite plugin list already contains the Opslane plugin."),
  agentStatus("sourcemaps install-plugin", "unsupported", 1, "stdout", "The config shape cannot be edited safely; follow the returned manual completion path."),
  agentStatus("sourcemaps install-plugin", "legacy_opslane_plugin", 1, "stdout", "The config uses the legacy Opslane plugin and must be migrated instead of double-registered."),
  agentStatus("sourcemaps install-plugin", "config_not_found", 1, "stdout", "No Vite config was found in the selected app directory."),
  agentStatus("sourcemaps install-plugin", "multiple_configs", 1, "stdout", "Several Vite configs were found and the command refuses to guess."),
  agentStatus("sourcemaps install-plugin", "unsafe_config", 1, "stdout", "The selected config escapes the repository or is not a safe regular file."),
  agentStatus("sourcemaps install-plugin", "vite_not_installed", 1, "stdout", "The selected app has no resolvable Vite installation."),
  agentStatus("sourcemaps install-plugin", "vite_version_unsupported", 1, "stdout", "The installed Vite version is below the supported major-version floor."),
  agentStatus("sourcemaps install-plugin", "sdk_not_installed", 1, "stdout", "The selected app has no resolvable Opslane SDK installation."),
  agentStatus("sourcemaps install-plugin", "plugin_not_available_yet", 1, "stdout", "The installed SDK does not yet satisfy the frozen Vite plugin contract."),
  agentStatus("sourcemaps install-plugin", "vite_config_broken_before_edit", 1, "stdout", "The original Vite config failed to resolve, so nothing was written."),
  agentStatus("sourcemaps install-plugin", "vite_config_parse_failed", 1, "stdout", "The written config did not parse and the original file was restored."),
  agentStatus("sourcemaps install-plugin", "vite_config_structure_mismatch", 1, "stdout", "The reread config did not contain the expected structure and the original file was restored."),
  agentStatus("sourcemaps install-plugin", "vite_plugin_not_registered", 1, "stdout", "The resolved config omitted the Opslane plugin; any command edit was restored."),
  agentStatus("sourcemaps install-plugin", "vite_config_broken_after_edit", 1, "stdout", "The edited Vite config failed to resolve and the original file was restored."),
  agentStatus("sourcemaps install-plugin", "vite_config_resolve_timeout", 1, "stdout", "Post-edit Vite resolution timed out, the child stopped, and the original file was restored."),
  agentStatus("sourcemaps install-plugin", "config_changed_before_write", 1, "stdout", "The config changed after preview, so the command refused to overwrite it."),
  agentStatus("sourcemaps install-plugin", "repo_changed_during_verification", 1, "stdout", "Config execution changed another repository path; the command stopped and restored its edit."),
  agentStatus("sourcemaps install-plugin", "write_failed", 1, "stdout", "The atomic config write failed and the original file was restored."),
  agentStatus("sourcemaps install-plugin", "restore_failed", 1, "stdout", "The original config could not be restored; recovery details and a backup path are reported."),
] as const satisfies readonly AgentStatusContract[];

export type AgentStatus = (typeof AGENT_STATUSES)[number]['status'];
