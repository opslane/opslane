export function makeSourceMapKey(endpoint: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, iat: '2026-09-11T00:00:00Z', url: endpoint })).toString('base64url');
  return `opslane_sk_${'a'.repeat(26)}_${'a'.repeat(43)}_${payload}`;
}
