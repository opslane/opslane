import type { OnboardingPlan } from './tools.js';

export function renderDetectSpec({ cwd }: { cwd: string }): string {
  return `# Goal

Inspect the repository at ${cwd} and REPORT how @opslane/sdk should be wired in.
You have no edit tools; only read and report. Do not attempt to change any file.

# Investigate

Read the repository and use the secret-aware search tool to determine:
- the one web app to onboard; in a monorepo, select the primary user-facing web app;
- whether the repository is unsupported because it has no web app;
- the selected app's framework and real entry point;
- the environment-variable naming convention and prefix this app actually uses, and
  crucially whether that prefix is one the bundler exposes to the BROWSER. A variable
  the browser cannot read makes the SDK receive undefined and never report anything.
  Vite exposes only names starting with the configured prefix (VITE_ by default, see
  "envPrefix"). Next.js exposes only NEXT_PUBLIC_ automatically; any other name has to
  be listed in next.config "env", which you may NOT edit, so prefer NEXT_PUBLIC_ there
  even when the repo uses another prefix for its own server-side variables;
- which directory the bundler loads .env files from. This is often NOT the app
  directory. Vite's "envDir" option moves it, and monorepos commonly point it at the
  repository root; check the app's vite config and note where existing .env files
  actually live;
- the package manager, based on the repository lock file;
- the script in the selected app's package.json that starts its dev server; and
- any existing error or monitoring SDK, including Sentry, PostHog, @defender-dev/sdk,
  or @opslane/sdk.

If several web apps are genuinely equally plausible, call ask_user with multi:false and
have the user select exactly one. Base every field on what the repository files show.

# Report

Call report_plan exactly once and make no further tool calls afterward.
- If there is no web app to onboard, report status "unsupported" with a concrete reason.
- Otherwise report status "ok" with the complete typed plan.
- Use the repo's own prefix for both Opslane variables. Name them after Opslane, such as
  VITE_OPSLANE_API_KEY or NEXT_PUBLIC_OPSLANE_API_KEY, and never borrow another product's
  name from the repository.
- Provide the exact import_line that Apply will place at module top level alongside
  existing imports. Separately, provide exact init_block code plus an exact anchor,
  position, and zero-based occurrence that locate the init block only. The anchor must
  equal the complete non-whitespace content of one line, including its semicolon.
- Provide env_dir: the repo-relative directory the bundler reads .env files from. The
  host writes .env.local there. Use "." for the repository root. Do not assume this
  equals app_dir; confirm it from the bundler config and from where existing .env files
  are kept.
- Provide manifest_file for the selected app's package.json. Do not provide a dependency
  version or compute any hash; the host pins the SDK version and records both file hashes.
- Provide dev_script: the exact key from the selected app's package.json "scripts" that
  starts its dev server. It must be one of that file's declared scripts. In a repo with
  several (dev, dev:staging, start), choose the one for the app you selected.
- Keep Opslane initialization able to coexist with any existing monitoring SDK, and set
  existing_sdk.action to exactly one of:
  - "none" when the repository has no error or monitoring SDK at all (name: null);
  - "keep" when another SDK is present and Opslane should run alongside it (name: that SDK);
  - "migrate" when the named SDK should be replaced, including an outdated
    @opslane/sdk version below 2.0.0 that cannot report SDK identity;
  - "no_op" only when an identity-capable @opslane/sdk version (at least 2.0.0) is
    already imported, initialized, and nothing should change.
- Never report secret values. Report environment-variable names only.
`;
}

export function renderApplySpec({
  cwd,
  plan,
}: {
  cwd: string;
  plan: OnboardingPlan;
}): string {
  return `# Goal

Apply exactly the approved onboarding plan below to ${cwd}. Change nothing else.

# Approved plan

- entry_file: ${plan.edit.file}
- manifest_file: ${plan.edit.manifest_file}
- import_line: ${plan.edit.import_line}
- init_block:
${plan.edit.init_block}
- init_anchor: ${plan.edit.anchor}
- init_position: ${plan.edit.position}
- init_occurrence_zero_based: ${plan.edit.occurrence}
- dependency_name: ${plan.dependency.name}
- dependency_version: ${plan.dependency.version}
- existing_sdk_action: ${plan.existing_sdk.action}
- existing_sdk_name: ${plan.existing_sdk.name ?? 'none'}

# Instructions

- Insert init_block ${plan.edit.position} the occurrence numbered ${plan.edit.occurrence}
  (zero-based) of init_anchor in entry_file. Match the surrounding indentation.
- Place import_line at module top level alongside the existing imports. Never place it
  inside a function, class, conditional, or other block.
- Add exactly ${plan.dependency.name}@${plan.dependency.version} to the dependencies
  object in manifest_file. Do not edit any other manifest field.
- Do not touch any file except entry_file and manifest_file.
- Do not reformat unrelated lines. Do not run installs or any shell command.
- For existing_sdk_action "none" or "keep", proceed and leave any other SDK untouched.
- The host handles "no_op" before starting this agent. If one reaches you, make no edits
  and stop without calling a tool.
- Migration is unsupported. If existing_sdk_action is "migrate", make no edits and stop;
  never attempt a partial migration.
- After both edits have settled, call finish_apply exactly once with the two files edited.
  Make no edits or other tool calls after finish_apply.
`;
}
