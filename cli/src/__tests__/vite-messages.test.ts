import { describe, expect, it } from 'vitest';

import {
  MANUAL_PLUGIN_LINES,
  renderInstallPlan,
  renderViteOutcome,
} from '../codemods/vite-messages.js';
import { suggestionAtLine } from '../codemods/vite-sourcemaps.js';

describe('Vite messages', () => {
  it('names the file and renders disclosure and host warnings', () => {
    const rendered = renderInstallPlan(
      'apps/web/vite.config.ts',
      MANUAL_PLUGIN_LINES,
      ['The file has uncommitted changes.', 'build.sourcemap is overridden.'],
    );
    expect(rendered).toContain('apps/web/vite.config.ts');
    expect(rendered).toContain('readable copy of your source code');
    expect(rendered).toContain('uncommitted changes');
    expect(rendered).toContain('build.sourcemap');
    expect(rendered).toContain('not a sandbox');
    expect(rendered).toContain('https://docs.opslane.com/guides/source-map-privacy');
  });

  it.each([
    'no_default_export',
    'unsupported_config_shape',
    'plugins_not_array',
    'plugins_shorthand',
    'duplicate_plugins_key',
    'plugins_would_be_overwritten',
    'unsafe_suggestion',
  ] as const)('ordinary refusal %s ends with a manual completion path', (reason) => {
    const rendered = renderViteOutcome('vite.config.ts', { outcome: 'unsupported', reason });
    expect(rendered).toContain('vite.config.ts');
    expect(rendered).toContain(MANUAL_PLUGIN_LINES);
    expect(rendered).toContain('opslane sourcemaps install-plugin --check');
  });

  it('the legacy message never recommends the refused paste', () => {
    const legacy = renderViteOutcome('vite.config.ts', {
      outcome: 'legacy_opslane_plugin',
    });
    for (const rendered of [legacy]) {
      expect(rendered).toContain('vite.config.ts');
      expect(rendered).not.toContain(MANUAL_PLUGIN_LINES);
      expect(rendered).toContain('Opslane still catches and groups errors');
    }
    expect(legacy).toContain('https://docs.opslane.com/guides/source-maps');
  });

  it('renders a moved, structurally-valid suggestion at its new line', () => {
    const source = `export default {\n  plugins: [\n    react(),\n  ],\n}\n`;
    const moved = suggestionAtLine(source, 'vite.config.ts', 3);
    expect(moved.outcome).toBe('suggested');
    if (moved.outcome !== 'suggested') return;
    const rendered = renderViteOutcome('apps/web/vite.config.ts', moved);
    expect(rendered).toContain('apps/web/vite.config.ts');
    expect(rendered).toContain('>   3 |');
    expect(rendered).toContain('we would add it here');
  });
});
