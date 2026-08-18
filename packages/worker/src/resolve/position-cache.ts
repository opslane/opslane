import { getPool } from '../db.js';
import { RESOLVER_VERSION } from './envelope.js';

export interface PositionKey {
  projectId: string;
  debugId: string;
  mapContentSha: string;
  line: number;
  column: number;
}

export interface CachedPosition {
  originalFile: string;
  originalFunction: string;
  originalLine: number;
}

export async function lookupPosition(key: PositionKey): Promise<CachedPosition | null> {
  const result = await getPool().query<{
    original_file: string;
    original_function: string;
    original_line: number;
  }>(
    `SELECT original_file, original_function, original_line
       FROM sourcemap_position_cache
      WHERE project_id = $1
        AND debug_id = $2
        AND map_content_sha = $3
        AND resolver_version = $4
        AND generated_line = $5
        AND generated_column = $6`,
    [
      key.projectId,
      key.debugId,
      key.mapContentSha,
      RESOLVER_VERSION,
      key.line,
      key.column,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    originalFile: row.original_file,
    originalFunction: row.original_function,
    originalLine: row.original_line,
  };
}

export async function storePosition(
  key: PositionKey,
  value: CachedPosition,
): Promise<void> {
  await getPool().query(
    `INSERT INTO sourcemap_position_cache
       (project_id, debug_id, map_content_sha, resolver_version,
        generated_line, generated_column, original_file, original_function, original_line)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING`,
    [
      key.projectId,
      key.debugId,
      key.mapContentSha,
      RESOLVER_VERSION,
      key.line,
      key.column,
      value.originalFile,
      value.originalFunction,
      value.originalLine,
    ],
  );
}
