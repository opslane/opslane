import { parseArgs, runSourcemapsCli } from './index';

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv, process.env);
  if ('error' in opts) { console.error(opts.error); return 2; }
  if ('skip' in opts) { console.warn(opts.skip); return 0; }
  const summary = await runSourcemapsCli(opts);
  return summary.failed.length ? 1 : 0;
}

export { parseArgs, runSourcemapsCli } from './index';
export type { CliOptions, CliSummary } from './index';
