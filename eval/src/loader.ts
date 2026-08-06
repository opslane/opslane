import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { EvalCase } from './types.js';
import { validateCase } from './validate.js';

export async function loadCase(caseDir: string): Promise<EvalCase> {
  const raw = await readFile(path.join(caseDir, 'case.json'), 'utf-8');
  return validateCase(JSON.parse(raw), caseDir);
}

/** Load gold patch content by convention (gold.patch file in case dir). Returns null if absent. */
export async function loadGoldPatch(caseDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(caseDir, 'gold.patch'), 'utf-8');
  } catch {
    return null;
  }
}

export async function loadAllCases(casesDir: string): Promise<EvalCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  const cases: EvalCase[] = [];
  for (const dir of dirs) {
    cases.push(await loadCase(path.join(casesDir, dir)));
  }
  return cases;
}
