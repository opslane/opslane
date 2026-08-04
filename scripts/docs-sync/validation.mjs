import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SNIPPET_CLASSES = new Set([
  'runnable',
  'fragment',
  'config-template',
  'expected-output',
  'illustrative',
]);

export const DEFAULT_ADVISORY_CHANGED_LINES = 80;
export const DEFAULT_SNIPPET_MANIFEST = fileURLToPath(new URL('./snippets.json', import.meta.url));

export function loadSnippetManifest(path = DEFAULT_SNIPPET_MANIFEST) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`unable to read snippet manifest ${path}: ${error.message}`);
  }
  if (manifest?.version !== 1 || !manifest.documents || typeof manifest.documents !== 'object') {
    throw new Error(`invalid snippet manifest: ${path}`);
  }
  return manifest;
}

function frontmatterOf(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const match = text.match(/^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m);
  if (!match) throw new Error('unterminated frontmatter');
  return match[0];
}

export function parseMarkdownFences(text) {
  const lines = text.split(/\r?\n/);
  const fences = [];
  let open = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!open) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (!match) continue;
      const info = match[2].trim();
      // CommonMark permits an info-string-less fence; treat it as an untagged
      // (language-less) block rather than rejecting the whole document.
      const language = info ? info.split(/\s+/)[0].toLowerCase() : '';
      open = {
        marker: match[1][0],
        length: match[1].length,
        language,
        info,
        startLine: index + 1,
        body: [],
      };
      continue;
    }

    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.marker && close[1].length >= open.length) {
      fences.push({
        index: fences.length + 1,
        language: open.language,
        info: open.info,
        startLine: open.startLine,
        endLine: index + 1,
        content: open.body.join('\n'),
      });
      open = null;
    } else {
      open.body.push(line);
    }
  }

  if (open) throw new Error(`unclosed code fence at line ${open.startLine}`);
  return fences;
}

function assertBasicMermaid(fence) {
  const meaningful = fence.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'));
  if (meaningful.length === 0) throw new Error(`empty Mermaid fence at line ${fence.startLine}`);
  if (!/^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|requirementDiagram|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/.test(meaningful[0])) {
    throw new Error(`Mermaid fence at line ${fence.startLine} has no supported diagram declaration`);
  }
  const pairs = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
  const closing = new Set(pairs.values());
  const stack = [];
  // Mermaid node labels are quoted ("...") and may legitimately contain parens
  // or brackets; strip quoted spans so label text doesn't skew this structural
  // delimiter-balance heuristic and falsely reject a valid diagram.
  for (const character of meaningful.join('\n').replace(/"[^"]*"/g, '')) {
    if (pairs.has(character)) stack.push(pairs.get(character));
    else if (closing.has(character) && stack.pop() !== character) {
      throw new Error(`Mermaid fence at line ${fence.startLine} has unbalanced delimiters`);
    }
  }
  if (stack.length > 0) throw new Error(`Mermaid fence at line ${fence.startLine} has unbalanced delimiters`);
}

function isSafeRepoRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
    posix.normalize(value) === value && value !== '.' && !value.startsWith('/') && !value.startsWith('../');
}

export function checkedRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout ?? '';
}

export function validateCheckoutSite({ checkoutRoot, runner = checkedRunner }) {
  runner('pnpm', ['--ignore-workspace', '--dir', join(checkoutRoot, 'docs-site'), 'build'], {
    cwd: checkoutRoot,
  });
}

function assertInside(root, candidate, label) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`${label} escapes its root`);
  }
  return absoluteCandidate;
}

function assertNoSymlinkParents(root, target) {
  const relative = target.slice(resolve(root).length + 1);
  let current = resolve(root);
  for (const segment of relative.split(sep)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`runnable snippet target traverses a symlink: ${relative}`);
  }
}

export function isSetupDoc(docPath) {
  return docPath === 'docs/install.md' || docPath.startsWith('docs/guides/') || docPath.startsWith('docs/quickstart/');
}

export function validateSnippetContract(docPath, fences, snippetManifest) {
  if (!isSetupDoc(docPath)) return;
  if (!snippetManifest || snippetManifest.version !== 1 || typeof snippetManifest.documents !== 'object') {
    throw new Error('snippet manifest version 1 is required for setup documentation');
  }
  const declared = snippetManifest.documents[docPath]?.fences;
  if (!Array.isArray(declared)) throw new Error(`setup fences are not classified for ${docPath}`);
  if (declared.length !== fences.length) {
    throw new Error(`setup fence classification count mismatch for ${docPath}: found ${fences.length}, declared ${declared.length}`);
  }
  for (let index = 0; index < fences.length; index += 1) {
    const fence = fences[index];
    const entry = declared[index];
    if (!entry || entry.language !== fence.language) {
      throw new Error(`setup fence ${index + 1} language mismatch for ${docPath}`);
    }
    if (!SNIPPET_CLASSES.has(entry.classification)) {
      throw new Error(`setup fence ${index + 1} has no valid classification for ${docPath}`);
    }
    if (entry.classification === 'runnable') {
      if (!isSafeRepoRelativePath(entry.fixture) || !isSafeRepoRelativePath(entry.target)) {
        throw new Error(`runnable fence ${index + 1} has unsafe fixture metadata for ${docPath}`);
      }
      if (!Array.isArray(entry.command) || entry.command.length === 0 || entry.command.some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\0'))) {
        throw new Error(`runnable fence ${index + 1} must use a nonempty command argv array for ${docPath}`);
      }
    } else if ('fixture' in entry || 'target' in entry || 'command' in entry) {
      throw new Error(`non-runnable fence ${index + 1} has runnable metadata for ${docPath}`);
    }
  }
}

export function changedLineCount(original, edited) {
  const before = original.split(/\r?\n/);
  const after = edited.split(/\r?\n/);
  const rows = before.length + 1;
  const columns = after.length + 1;
  let previous = new Uint32Array(columns);
  for (let i = 1; i < rows; i += 1) {
    const current = new Uint32Array(columns);
    for (let j = 1; j < columns; j += 1) {
      current[j] = before[i - 1] === after[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const common = previous[columns - 1];
  return before.length + after.length - (2 * common);
}

export function validateContentEdit({
  docPath,
  original,
  edited,
  snippetManifest,
  advisoryChangedLines = DEFAULT_ADVISORY_CHANGED_LINES,
}) {
  if (typeof docPath !== 'string' || typeof original !== 'string' || typeof edited !== 'string') {
    throw new TypeError('docPath, original, and edited are required strings');
  }
  if (frontmatterOf(original) !== frontmatterOf(edited)) {
    throw new Error(`frontmatter changed for ${docPath}`);
  }
  if (/<\/?(?:content|changed)\s*>/i.test(edited)) {
    throw new Error(`structured-output wrapper tags leaked into ${docPath}`);
  }
  const fences = parseMarkdownFences(edited);
  for (const fence of fences.filter(({ language }) => language === 'mermaid')) assertBasicMermaid(fence);
  validateSnippetContract(docPath, fences, snippetManifest);

  const changedLines = changedLineCount(original, edited);
  const warnings = [];
  if (Number.isSafeInteger(advisoryChangedLines) && advisoryChangedLines >= 0 && changedLines > advisoryChangedLines) {
    warnings.push({
      code: 'large-docs-diff',
      message: `${docPath} changes ${changedLines} lines (advisory threshold: ${advisoryChangedLines})`,
      changedLines,
      threshold: advisoryChangedLines,
    });
  }
  return { fences, warnings, changedLines };
}

export function runRunnableSnippets({ checkoutRoot, fixtureRepoRoot = checkoutRoot, docPaths, snippetManifest, runner = checkedRunner }) {
  for (const docPath of docPaths) {
    const entries = snippetManifest?.documents?.[docPath]?.fences ?? [];
    if (!entries.some(({ classification }) => classification === 'runnable')) continue;
    const document = readFileSync(join(checkoutRoot, docPath), 'utf8');
    const fences = parseMarkdownFences(document);
    validateSnippetContract(docPath, fences, snippetManifest);

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.classification !== 'runnable') continue;
      const fixtureRoot = assertInside(fixtureRepoRoot, join(fixtureRepoRoot, entry.fixture), 'runnable fixture');
      if (!lstatSync(fixtureRoot).isDirectory()) throw new Error(`runnable fixture is not a directory: ${entry.fixture}`);
      const tempRoot = mkdtempSync(join(tmpdir(), 'docs-sync-snippet-'));
      const tempFixture = join(tempRoot, 'fixture');
      try {
        cpSync(fixtureRoot, tempFixture, {
          recursive: true,
          filter: (source) => {
            const relative = source.slice(fixtureRoot.length).replace(/^[/\\]/, '');
            return relative !== 'node_modules' && !relative.startsWith(`node_modules${sep}`) &&
              relative !== 'dist' && !relative.startsWith(`dist${sep}`);
          },
        });
        const fixtureModules = join(fixtureRoot, 'node_modules');
        if (existsSync(fixtureModules)) symlinkSync(fixtureModules, join(tempFixture, 'node_modules'), 'dir');
        const target = assertInside(tempFixture, join(tempFixture, entry.target), 'runnable target');
        assertNoSymlinkParents(tempFixture, target);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${fences[index].content}\n`);
        runner(entry.command[0], entry.command.slice(1), { cwd: tempFixture });
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  }
}

function copyTree(sourceRoot, destinationRoot, { excluded = new Set() } = {}, relative = '') {
  const source = join(sourceRoot, relative);
  const destination = join(destinationRoot, relative);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name.startsWith('.docs-sync-site-')) continue;
    const child = join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Stage-2 overlay rejects symlink data: ${child}`);
    if (entry.isDirectory()) copyTree(sourceRoot, destinationRoot, { excluded }, child);
    else if (entry.isFile()) {
      mkdirSync(dirname(join(destinationRoot, child)), { recursive: true });
      copyFileSync(join(sourceRoot, child), join(destinationRoot, child));
    } else {
      throw new Error(`Stage-2 overlay rejects non-regular data: ${child}`);
    }
  }
}

function hardlinkTree(sourceRoot, destinationRoot, relative = '') {
  const source = join(sourceRoot, relative);
  const destination = join(destinationRoot, relative);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const child = join(relative, entry.name);
    const target = join(destinationRoot, child);
    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(join(sourceRoot, child)), target);
    else if (entry.isDirectory()) hardlinkTree(sourceRoot, destinationRoot, child);
    else if (entry.isFile()) linkSync(join(sourceRoot, child), target);
    else throw new Error(`trusted dependency tree contains a non-regular entry: ${child}`);
  }
}

export function validateSiteOverlay({ checkoutRoot, trustedRoot, runner = checkedRunner }) {
  const overlayRoot = mkdtempSync(join(trustedRoot, '.docs-sync-site-'));
  try {
    copyTree(checkoutRoot, overlayRoot, {
      // The PR tree is content data only. In particular, never let its pnpm
      // settings or workspace metadata influence the trusted site command.
      excluded: new Set([
        '.git',
        '.npmrc',
        '.pnpmfile.cjs',
        'node_modules',
        'docs-site',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
      ]),
    });
    copyTree(join(trustedRoot, 'docs-site'), join(overlayRoot, 'docs-site'), {
      excluded: new Set(['.astro', 'dist', 'node_modules']),
    });
    const trustedRootModules = join(trustedRoot, 'node_modules');
    const trustedSiteModules = join(trustedRoot, 'docs-site/node_modules');
    if (!existsSync(trustedRootModules) || !existsSync(trustedSiteModules)) {
      throw new Error('trusted dependencies are not installed for Stage-2 docs-site validation');
    }
    // Astro/Vite keys virtual-module metadata by absolute module path. Keep the
    // trusted dependencies inside the temporary workspace so a module cannot
    // appear once through the overlay and once through the trusted checkout.
    // Hard links avoid an expensive byte-for-byte dependency copy and are
    // read-only inputs to the build; output stays inside the temporary tree.
    hardlinkTree(trustedRootModules, join(overlayRoot, 'node_modules'));
    hardlinkTree(trustedSiteModules, join(overlayRoot, 'docs-site/node_modules'));
    runner('pnpm', ['--ignore-workspace', '--dir', join(overlayRoot, 'docs-site'), 'build'], { cwd: overlayRoot });
  } finally {
    rmSync(overlayRoot, { recursive: true, force: true });
  }
}
