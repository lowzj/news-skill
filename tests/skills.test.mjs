import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { installSkills, readSkill } from '../skills/news/scripts/skills.js';

const execute = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'news-skills-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  await Promise.all([mkdir(join(source, 'scripts'), { recursive: true }), mkdir(home), mkdir(cwd)]);
  await writeFile(join(source, 'SKILL.md'), '---\nname: news\ndescription: Read NEWS\n---\nRun scripts/news.js.\n');
  await writeFile(join(source, 'package.json'), '{"type":"module","version":"0.1.0"}\n');
  await writeFile(join(source, 'scripts', 'news.js'), "#!/usr/bin/env node\nimport { basename } from 'node:path';\nconsole.log(basename('/self-contained/news'));\n");
  await chmod(join(source, 'scripts', 'news.js'), 0o755);
  await mkdir(join(source, 'references'));
  await writeFile(join(source, 'references', 'api.md'), 'API reference\n');
  return { root, source, home, cwd, env: {} };
}

async function absent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

test('user installation is a runnable, self-contained copy and repeated installation is unchanged', async t => {
  const options = await fixture(t);
  const result = await installSkills({ ...options, agent: 'codex' });
  const target = join(options.home, '.agents', 'skills', 'news');
  assert.deepEqual(result, { installations: [{ agent: 'codex', scope: 'user', path: target, status: 'installed' }] });
  assert.equal((await lstat(target)).isSymbolicLink(), false);
  assert.equal(await readFile(join(target, 'references', 'api.md'), 'utf8'), 'API reference\n');
  assert.equal((await lstat(join(target, 'scripts', 'news.js'))).mode & 0o111, 0o111);
  const installedStat = await lstat(join(target, 'SKILL.md'));
  assert.equal((await installSkills({ ...options, agent: 'codex' })).installations[0].status, 'unchanged');
  assert.equal((await lstat(join(target, 'SKILL.md'))).mtimeMs, installedStat.mtimeMs);
  await rm(options.source, { recursive: true });
  const output = await execute(process.execPath, [join(target, 'scripts', 'news.js')], { cwd: options.cwd });
  assert.equal(output.stdout, 'news\n');
});

test('all project installations use the four project paths without touching the home', async t => {
  const options = await fixture(t);
  const result = await installSkills({ ...options, agent: 'all', scope: 'project' });
  assert.deepEqual(result.installations.map(item => [item.agent, item.path]), [
    ['codex', join(options.cwd, '.agents', 'skills', 'news')],
    ['claude', join(options.cwd, '.claude', 'skills', 'news')],
    ['opencode', join(options.cwd, '.opencode', 'skills', 'news')],
    ['pi', join(options.cwd, '.pi', 'skills', 'news')],
  ]);
  assert.deepEqual(await readdir(options.home), []);
  assert.ok(result.installations.every(item => item.status === 'installed' && item.scope === 'project'));
});

test('OpenCode and Pi respect their user directory environment overrides', async t => {
  const options = await fixture(t);
  const env = { XDG_CONFIG_HOME: join(options.root, 'config'), PI_CODING_AGENT_DIR: join(options.root, 'pi-config') };
  const result = await installSkills({ ...options, env, agent: 'all' });
  assert.equal(result.installations.find(item => item.agent === 'opencode').path, join(env.XDG_CONFIG_HOME, 'opencode', 'skills', 'news'));
  assert.equal(result.installations.find(item => item.agent === 'pi').path, join(env.PI_CODING_AGENT_DIR, 'skills', 'news'));
  assert.equal(result.installations.find(item => item.agent === 'claude').path, join(options.home, '.claude', 'skills', 'news'));
  await absent(join(options.home, '.config'));
  await absent(join(options.home, '.pi'));
});

test('changed owned installations require force, which replaces only the selected skill', async t => {
  const options = await fixture(t);
  const { installations } = await installSkills({ ...options, agent: 'codex' });
  const target = installations[0].path;
  const sibling = join(options.home, '.agents', 'skills', 'other');
  await mkdir(sibling);
  await writeFile(join(sibling, 'SKILL.md'), 'Another skill');
  await writeFile(join(target, 'local-file.txt'), 'locally modified');
  await writeFile(join(options.source, 'references', 'api.md'), 'New API reference\n');
  await assert.rejects(installSkills({ ...options, agent: 'codex' }), /Use --force/);
  assert.equal(await readFile(join(target, 'references', 'api.md'), 'utf8'), 'API reference\n');
  assert.equal((await installSkills({ ...options, agent: 'codex', force: true })).installations[0].status, 'updated');
  assert.equal(await readFile(join(target, 'references', 'api.md'), 'utf8'), 'New API reference\n');
  await absent(join(target, 'local-file.txt'));
  assert.equal(await readFile(join(sibling, 'SKILL.md'), 'utf8'), 'Another skill');
  assert.deepEqual((await readdir(join(options.home, '.agents', 'skills'))).sort(), ['news', 'other']);
});

test('force does not replace unowned skills, and all destinations are preflighted before writes', async t => {
  const options = await fixture(t);
  const existing = join(options.home, '.claude', 'skills', 'news');
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, 'SKILL.md'), 'Unrelated news skill');
  await assert.rejects(installSkills({ ...options, agent: 'all', force: true }), /unowned skill/);
  assert.equal(await readFile(join(existing, 'SKILL.md'), 'utf8'), 'Unrelated news skill');
  assert.deepEqual(await readdir(options.home), ['.claude']);
  assert.deepEqual(await readdir(join(options.home, '.claude', 'skills')), ['news']);
});

test('refuses symlink destinations and symlinks in the bundled source', async t => {
  const options = await fixture(t);
  const outside = join(options.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep');
  const target = join(options.home, '.agents', 'skills', 'news');
  await mkdir(join(options.home, '.agents', 'skills'), { recursive: true });
  await symlink(outside, target, 'dir');
  await assert.rejects(installSkills({ ...options, agent: 'codex', force: true }), /symlink/);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
  await symlink(join(outside, 'keep.txt'), join(options.source, 'linked.txt'));
  await assert.rejects(installSkills({ ...options, agent: 'pi' }), /symlink/);
  await absent(join(options.home, '.pi'));
});

test('refuses overlap between source and destination in either direction', async t => {
  const options = await fixture(t);
  await assert.rejects(installSkills({ ...options, agent: 'codex', scope: 'project', cwd: options.source }), /overlap/);
  const destination = join(options.home, '.agents', 'skills', 'news');
  const nestedSource = join(destination, 'source');
  await mkdir(nestedSource, { recursive: true });
  await writeFile(join(nestedSource, 'SKILL.md'), 'source nested in destination');
  await assert.rejects(installSkills({ ...options, agent: 'codex', source: nestedSource, force: true }), /overlap/);
  assert.equal(await readFile(join(nestedSource, 'SKILL.md'), 'utf8'), 'source nested in destination');
});

test('refuses overlapping agent destinations before any installation writes', async t => {
  const options = await fixture(t);
  await assert.rejects(installSkills({ ...options, agent: 'all', env: { PI_CODING_AGENT_DIR: join(options.home, '.agents') } }), /paths overlap/);
  assert.deepEqual(await readdir(options.home), []);
});

test('validates agent, scope, and source, and can read the bundled skill text', async t => {
  const options = await fixture(t);
  await assert.rejects(installSkills({ ...options, agent: 'unknown' }), /Choose an agent/);
  await assert.rejects(installSkills({ ...options, agent: '', scope: 'user' }), /Choose an agent/);
  await assert.rejects(installSkills({ ...options, agent: 'codex', scope: 'global' }), /scope must be/);
  assert.match(await readSkill(options.source), /name: news/);
  await rm(join(options.source, 'SKILL.md'));
  await assert.rejects(installSkills({ ...options, agent: 'codex' }), /missing SKILL.md/);
  assert.deepEqual(await readdir(options.home), []);
});
