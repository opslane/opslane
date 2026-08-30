import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as tools from '../investigate-tools.js';

const src = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/**
 * The job sources whose repository access must now happen inside a sandbox.
 *
 * `product-context/job.ts` is deliberately absent: its `discoverRepositoryRoutes`
 * walk reads up to 10,000 files on the host and needs a seam `RepoReader` does
 * not provide, so it was descoped from this change and is tracked separately.
 * The descoped assertion below states that out loud rather than letting the
 * silence read as coverage.
 */
const ISOLATED_JOB_SOURCES = ['investigate.ts', 'inquiry/job.ts', 'friction/investigate-friction.ts'];
const DESCOPED_JOB_SOURCES = ['product-context/job.ts'];

describe('read-only jobs no longer read the host', () => {
  it('exports no host reader and no lexical path guard', () => {
    expect(Object.keys(tools)).not.toContain('createHostReader');
    expect(Object.keys(tools)).not.toContain('safePath');
  });

  it('investigate-tools does not import the filesystem', () => {
    expect(src('investigate-tools.ts')).not.toMatch(/from 'node:fs/);
  });

  it('the quote checker no longer reads the host synchronously', () => {
    expect(src('investigate.ts')).not.toMatch(/readFileSync|statSync/);
  });

  it.each(ISOLATED_JOB_SOURCES)('%s touches neither the host filesystem nor a subprocess', (file) => {
    const text = src(file);
    expect(text).not.toMatch(/from 'node:(fs|child_process)/);
    expect(text).not.toMatch(/execFile/);
  });

  it.each(DESCOPED_JOB_SOURCES)('%s is a known, tracked gap that still reads the host', (file) => {
    // Asserted so that isolating it fails this test and forces the file out of
    // DESCOPED_JOB_SOURCES and into ISOLATED_JOB_SOURCES, rather than leaving a
    // stale exemption behind.
    expect(src(file)).toMatch(/from 'node:fs/);
  });
});
