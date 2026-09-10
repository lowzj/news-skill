import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run smoke:package after building.');
const temporary = await mkdtemp(join(tmpdir(), 'news-package-'));
const project = join(temporary, 'project');
const prefix = join(temporary, 'installed');
const cache = join(temporary, 'cache');
const run = (args, cwd = root) => execute(process.execPath, [npm, ...args], { cwd, maxBuffer: 4 * 1024 * 1024 });
try {
  await mkdir(project);
  const packed = await run(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]);
  const [archive] = JSON.parse(packed.stdout);
  const files = new Set(archive.files.map(file => file.path));
  for (const file of ['skills/news/SKILL.md', 'skills/news/package.json', 'skills/news/scripts/news.js', 'skills/news/scripts/query.js', 'skills/news/scripts/skills.js']) {
    assert.ok(files.has(file), `Package is missing ${file}`);
  }
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'The published CLI must have no runtime dependencies');
  assert.ok(![...files].some(file => /(^|\/)node_modules\//.test(file) || file.startsWith('src/')));
  const tarball = join(temporary, archive.filename);
  await run(['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', tarball]);
  const installedCli = join(prefix, 'node_modules', '.bin', 'news');
  const version = await execute(process.execPath, [installedCli, '--version'], { cwd: project });
  assert.equal(version.stdout.trim(), pkg.version);
  // Exercise the documented npx-style flow from a packed artifact, without a
  // registry package, source checkout, TypeScript, or the user's global skills.
  const installed = await run(['exec', '--offline', '--yes', '--cache', cache, `--package=${tarball}`, '--',
    'news', 'skills', 'install', '--agent', 'all', '--scope', 'project'], project);
  const result = JSON.parse(installed.stdout);
  assert.equal(result.installations.length, 4);
  assert.ok(result.installations.every(item => item.status === 'installed'));
  await rm(cache, { recursive: true, force: true });
  await rm(prefix, { recursive: true, force: true });
  for (const item of result.installations) {
    const runtime = join(item.path, 'scripts', 'news.js');
    const output = await execute(process.execPath, [runtime, '--version'], { cwd: project });
    assert.equal(output.stdout.trim(), pkg.version);
    const skill = await execute(process.execPath, [runtime, 'skills', 'show'], { cwd: project });
    assert.match(skill.stdout, /name: news/);
  }
  console.log(`Package smoke check passed: ${(archive.size / 1024).toFixed(1)} KiB, install without dev dependencies, npx, and 4 self-contained skills.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
