import type { ViteEditResult } from './vite-sourcemaps.js';

export const SOURCE_MAP_DISCLOSURE =
  'Later, when you add your key in CI, production source maps are uploaded to Opslane. '
  + 'A source map is a readable copy of your source code. Resolved source also reaches '
  + 'the AI model that writes fix pull requests. Maps are isolated per project, cannot '
  + 'be downloaded through Opslane, and do not expire yet. '
  + 'Read https://docs.opslane.com/guides/source-map-privacy.';

export const MANUAL_PLUGIN_LINES =
  "import { opslane } from '@opslane/sdk/vite-plugin';\n"
  + 'opslane(),';

const MANUAL_FINISH =
  `${MANUAL_PLUGIN_LINES}\n\nAfter editing, run: opslane sourcemaps install-plugin --check`;

export function renderInstallPlan(
  file: string,
  diff: string,
  warnings: string[] = [],
): string {
  const warningBlock = warnings.length > 0
    ? `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join('\n')}`
    : '';
  return `${file}\n\n${diff}${warningBlock}\n\n${SOURCE_MAP_DISCLOSURE}\n\n`
    + 'Verification executes this Vite config with your installed Vite. The child process '
    + 'is killable but is not a sandbox; config code retains filesystem and network access.';
}

export function renderSuggestion(
  file: string,
  result: Pick<Extract<ViteEditResult, { outcome: 'suggested' }>, 'line' | 'preview'>,
): string {
  const firstLine = Math.max(1, result.line - 2);
  const preview = result.preview.map((text, index) => {
    const line = firstLine + index;
    const marker = line === result.line ? '>' : ' ';
    const suffix = line === result.line ? '          <- we would add it here' : '';
    return `${marker} ${String(line).padStart(3)} | ${text}${suffix}`;
  }).join('\n');
  return `${file}\n\n${preview}\n\n`
    + 'Add it there?  [Y]es  [m]ove it  [n]o, show me the two lines';
}

export function renderViteOutcome(file: string, result: ViteEditResult): string {
  if (result.outcome === 'legacy_opslane_plugin') {
    return `${file}\n\nThis config imports the legacy Opslane source-map plugin. Do not paste a second registration.\n\n`
      + 'Options:\n'
      + '1. Follow https://docs.opslane.com/guides/source-maps-migration, remove the legacy plugin, and re-run.\n'
      + '2. Migrate by hand and watch the first build before removing the old setup.\n'
      + '3. Skip source maps. Opslane still catches and groups errors; only original file and line numbers stay unreadable.';
  }
  if (result.outcome === 'suggested') return renderSuggestion(file, result);
  if (result.outcome === 'already_wired') {
    return `${file}\n\nThe Opslane Vite plugin is already registered.`;
  }
  if (result.outcome === 'edited') {
    return renderInstallPlan(file, MANUAL_PLUGIN_LINES);
  }
  return `${file}\n\nThis config cannot be edited safely (${result.reason}).\n\n${MANUAL_FINISH}`;
}
