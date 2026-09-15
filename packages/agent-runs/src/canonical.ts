function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item === undefined ? null : item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = normalize(child);
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted at every depth, for structural equality checks. */
export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(normalize(value));
  if (json === undefined) throw new Error('value is not JSON serializable');
  return json;
}
