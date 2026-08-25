import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import type { Loader, LoaderContext, ParseDataOptions } from 'astro/loaders';

import {
  canonicalId,
  composeDocsLoaders,
  createCanonicalEnricher,
  extractTitle,
  isAllowedCanonicalPath,
} from '../loaders/repo-docs';

interface StoredEntry {
  id: string;
  data: Record<string, unknown>;
  filePath?: string;
}

function testStore() {
  const entries = new Map<string, StoredEntry>();
  return {
    entries,
    store: {
      clear: () => entries.clear(),
      delete: (id: string) => entries.delete(id),
      get: (id: string) => entries.get(id),
      keys: () => entries.keys(),
      set: (entry: StoredEntry) => entries.set(entry.id, entry),
    },
  };
}

function loader(id?: string, registerWatch = false): Loader {
  return {
    name: id ?? 'empty',
    async load(context) {
      if (id) context.store.set({ id, data: { version: 1 } });
      if (id && registerWatch && context.watcher) {
        context.watcher.on('change', () => context.store.set({ id, data: { version: 2 } }));
      }
    },
  };
}

function contextWith(
  store: ReturnType<typeof testStore>['store'],
  watcher?: { on: (event: string, callback: () => void) => void },
): LoaderContext {
  return {
    collection: 'docs',
    store,
    watcher,
    parseData: async <TData extends Record<string, unknown>>({ data }: ParseDataOptions<TData>) => data,
  } as unknown as LoaderContext;
}

describe('canonical docs metadata', () => {
  it('extracts the only H1 and ignores heading-like lines in fences', () => {
    expect(extractTitle('# Source maps\n\n```yaml\n# e.g. GitHub Actions\n```', 'source-maps.md')).toBe(
      'Source maps',
    );
  });

  it('ignores heading-like lines in tilde fences', () => {
    expect(extractTitle('# Title\n\n~~~text\n# not a heading\n~~~', 'tilde.md')).toBe('Title');
  });

  it('rejects missing and multiple H1 headings', () => {
    expect(() => extractTitle('## Missing', 'missing.md')).toThrow('found 0');
    expect(() => extractTitle('# First\n\n# Second', 'multiple.md')).toThrow('found 2');
  });

  it('generates lowercase slugs', () => {
    expect(canonicalId('contracts/C4-amendments.md')).toBe('contracts/c4-amendments');
  });

  it('strips diacritics and non-ASCII punctuation in slugs', () => {
    expect(canonicalId('guides/Café Déjà—Vu.md')).toBe('guides/cafe-deja-vu');
  });

  it('allows only explicitly public documentation paths', () => {
    expect(isAllowedCanonicalPath('install.md')).toBe(true);
    expect(isAllowedCanonicalPath('how-it-works.md')).toBe(true);
    expect(isAllowedCanonicalPath('guides/friction.md')).toBe(true);
    expect(isAllowedCanonicalPath('guides/react.md')).toBe(false);
    expect(isAllowedCanonicalPath('quickstart/agent.md')).toBe(false);
    expect(isAllowedCanonicalPath('architecture/overview.md')).toBe(false);
    expect(isAllowedCanonicalPath('contracts/events.md')).toBe(false);
    expect(isAllowedCanonicalPath('plans/internal.md')).toBe(false);
    expect(isAllowedCanonicalPath('agents/domain.md')).toBe(false);
    expect(isAllowedCanonicalPath('evidence/run.md')).toBe(false);
  });
});

describe('canonical enricher', () => {
  const parseData = (async ({ data }: { data: Record<string, unknown> }) =>
    data) as unknown as LoaderContext['parseData'];

  it('derives title and edit URL from the canonical file', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'opslane-docs-'));
    const filePath = path.join(base, 'guides/friction.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '# React\n\nBody.');

    const enrich = createCanonicalEnricher(base);
    const props = { id: 'guides/friction', data: {} as Record<string, unknown>, filePath };
    await enrich(props as ParseDataOptions<Record<string, unknown>>, parseData);

    expect(props.data.title).toBe('React');
    expect(props.data.slug).toBe('guides/friction');
    expect(props.data.editUrl).toBe(
      'https://github.com/opslane/opslane/edit/main/docs/guides/friction.md',
    );
  });

  it('rejects entries with a missing source file', async () => {
    const enrich = createCanonicalEnricher('/tmp/nonexistent-base');
    const props = { id: 'guides/friction', data: {}, filePath: '/tmp/nonexistent-base/guides/friction.md' };
    await expect(
      enrich(props as ParseDataOptions<Record<string, unknown>>, parseData),
    ).rejects.toThrow('no readable source file');
  });

  it('rejects symlinks that resolve outside the public allowlist', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'opslane-docs-'));
    const secret = path.join(base, 'plans/secret.md');
    mkdirSync(path.dirname(secret), { recursive: true });
    writeFileSync(secret, '# Secret');
    const linkPath = path.join(base, 'guides/leaked.md');
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(secret, linkPath);

    const enrich = createCanonicalEnricher(base);
    const props = { id: 'guides/leaked', data: {}, filePath: linkPath };
    await expect(
      enrich(props as ParseDataOptions<Record<string, unknown>>, parseData),
    ).rejects.toThrow('outside the public allowlist');
  });

  it('rejects files outside the public allowlist', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'opslane-docs-'));
    const filePath = path.join(base, 'plans/internal.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '# Internal');

    const enrich = createCanonicalEnricher(base);
    const props = { id: 'plans/internal', data: {}, filePath };
    await expect(
      enrich(props as ParseDataOptions<Record<string, unknown>>, parseData),
    ).rejects.toThrow('outside the public allowlist');
  });
});

describe('composite loader', () => {
  it('guards against an empty canonical collection', async () => {
    const { store } = testStore();
    const composite = composeDocsLoaders({ canonical: loader(), site: loader('index') });
    await expect(composite.load(contextWith(store))).rejects.toThrow('No canonical docs matched');
  });

  it('rejects duplicate IDs and landing-page collisions', async () => {
    const { store } = testStore();
    const composite = composeDocsLoaders({ canonical: loader('index'), site: loader('index') });
    await expect(composite.load(contextWith(store))).rejects.toThrow('Duplicate docs ID "index"');
  });

  it('rejects two canonical files that slug to the same route', async () => {
    const { store } = testStore();
    const colliding: Loader = {
      name: 'colliding',
      async load(context) {
        context.store.set({ id: 'guides/replay-privacy', data: {}, filePath: 'docs/guides/replay-privacy.md' });
        context.store.set({ id: 'guides/replay-privacy', data: {}, filePath: 'docs/guides/replay_privacy.md' });
      },
    };
    const composite = composeDocsLoaders({ canonical: colliding, site: loader('index') });
    await expect(composite.load(contextWith(store))).rejects.toThrow('Route collision');
  });

  it('guards against a missing site-owned landing page', async () => {
    const { store } = testStore();
    const composite = composeDocsLoaders({ canonical: loader('guides/react'), site: loader() });
    await expect(composite.load(contextWith(store))).rejects.toThrow('No site-owned landing page');
  });

  it('keeps both sources and forwards dev watcher updates', async () => {
    const callbacks = new Map<string, () => void>();
    const watcher = { on: (event: string, callback: () => void) => callbacks.set(event, callback) };
    const { entries, store } = testStore();
    const composite = composeDocsLoaders({
      canonical: loader('guides/react', true),
      site: loader('index'),
    });

    await composite.load(contextWith(store, watcher));
    expect([...entries.keys()]).toEqual(['guides/react', 'index']);

    callbacks.get('change')?.();
    expect(entries.get('guides/react')?.data.version).toBe(2);
  });
});
