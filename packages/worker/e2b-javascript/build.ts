import { randomBytes } from 'node:crypto';
import { Template } from 'e2b';

/**
 * The shared JavaScript sandbox image.
 *
 * Node 22 is baked in because the stock E2B image ships 20.9, which predates
 * crypto.hash() and breaks modern Vite plugins. Without this, every JavaScript
 * run downloads and unpacks a Node tarball first, on a 180 second budget.
 *
 * Memory is set here because there is nowhere else: Sandbox.create takes no
 * memory option in e2b 2.45.
 */
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const SUFFIX = randomBytes(3).toString('hex');
const NAME = `opslane-javascript-${STAMP}-${SUFFIX}`;

const info = await Template.build(Template().fromNodeImage('22'), NAME, {
  memoryMB: 2048,
  cpuCount: 2,
  onBuildLogs: (entry) => console.log(entry.message),
});
console.log(JSON.stringify(info, null, 2));
