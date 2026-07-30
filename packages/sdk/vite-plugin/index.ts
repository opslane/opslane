export interface SourceMapPluginOptions {
  endpoint: string;
  apiKey: string;
  release?: string;
}

export function opslaneSourceMapPlugin(_options: SourceMapPluginOptions) {
  return {
    name: 'opslane-source-map',
    apply: 'build' as const,
    enforce: 'post' as const,

    configResolved(): never {
      // Source-map upload moved to a batch API that does not exist yet
      // (tracked in #218). Failing the build is better than silently
      // deleting maps and uploading nothing, which is what a 404 here
      // would produce.
      throw new Error(
        '[opslane] source-map upload is unavailable in this release. ' +
        'Remove opslaneSourceMapPlugin() from your Vite plugins until @opslane/sdk ships batch upload ' +
        '(see opslane/opslane-oss#218).',
      );
    },
  };
}
