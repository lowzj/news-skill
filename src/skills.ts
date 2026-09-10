import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Agent = 'codex' | 'claude' | 'opencode' | 'pi';
export type SkillScope = 'user' | 'project';
export interface InstallSkillsOptions {
  agent: Agent | 'all' | string;
  scope?: SkillScope | string;
  force?: boolean;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  source?: string;
}
export interface SkillInstallation {
  agent: Agent;
  scope: SkillScope;
  path: string;
  status: 'installed' | 'unchanged' | 'updated';
}

const AGENTS: Agent[] = ['codex', 'claude', 'opencode', 'pi'];
const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const MARKER = '.news-skill-install.json';
const OWNER = 'news-skill';
type Entry = { path: string; kind: 'directory' } | { path: string; kind: 'file'; data: Buffer; mode: number };
type Plan = SkillInstallation & { canonicalPath: string; originalHash?: string; staging?: string; movedOld?: boolean; installed?: boolean };

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function statOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

// Resolve even a not-yet-created path through its closest existing ancestor.
async function canonicalPath(path: string): Promise<string> {
  const stat = await statOrUndefined(path);
  if (stat) return realpath(path);
  const parent = dirname(path);
  if (parent === path) throw new Error(`Cannot resolve installation path: ${path}`);
  return join(await canonicalPath(parent), basename(path));
}

async function snapshot(root: string): Promise<Entry[]> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Skill path must be a directory, not a symlink: ${root}`);
  }
  const entries: Entry[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (prefix === '' && name === MARKER) continue;
      const path = join(directory, name);
      const local = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Skill contains a symlink: ${path}`);
      if (stat.isDirectory()) {
        entries.push({ path: local, kind: 'directory' });
        await visit(path, local);
      } else if (stat.isFile()) {
        entries.push({ path: local, kind: 'file', data: await readFile(path), mode: stat.mode & 0o777 });
      } else {
        throw new Error(`Skill contains an unsupported file: ${path}`);
      }
    }
  }
  await visit(root, '');
  return entries;
}

function fingerprint(entries: Entry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(JSON.stringify([entry.path, entry.kind]));
    if (entry.kind === 'file') {
      hash.update(JSON.stringify([entry.data.length, entry.mode & 0o111]));
      hash.update(entry.data);
    }
  }
  return hash.digest('hex');
}

async function assertOwned(path: string): Promise<void> {
  const marker = join(path, MARKER);
  const stat = await statOrUndefined(marker);
  if (stat?.isFile() && !stat.isSymbolicLink()) {
    try {
      const value: unknown = JSON.parse(await readFile(marker, 'utf8'));
      if (typeof value === 'object' && value !== null && 'owner' in value && value.owner === OWNER && 'schema' in value && value.schema === 1) return;
    } catch {
      // An invalid marker does not establish ownership.
    }
  }
  throw new Error(`Refusing to replace an existing unowned skill at ${path}. Move it aside before installing NEWS.`);
}

function destination(agent: Agent, scope: SkillScope, cwd: string, home: string, env: NodeJS.ProcessEnv): string {
  if (scope === 'project') {
    const dirs = { codex: '.agents', claude: '.claude', opencode: '.opencode', pi: '.pi' };
    return join(cwd, dirs[agent], 'skills', 'news');
  }
  switch (agent) {
    case 'codex': return join(home, '.agents', 'skills', 'news');
    case 'claude': return join(home, '.claude', 'skills', 'news');
    case 'opencode': return resolve(cwd, env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'skills', 'news');
    case 'pi': return resolve(cwd, env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'skills', 'news');
  }
}

async function ensureParents(path: string, created: string[]): Promise<void> {
  const stat = await statOrUndefined(path);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Installation parent is not a directory: ${path}`);
    return;
  }
  await ensureParents(dirname(path), created);
  try {
    await mkdir(path);
    created.push(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink()) throw new Error(`Installation parent changed: ${path}`);
  }
}

async function writeSnapshot(root: string, entries: Entry[]): Promise<void> {
  await mkdir(root);
  for (const entry of entries) {
    const path = join(root, entry.path);
    if (entry.kind === 'directory') await mkdir(path);
    else {
      await writeFile(path, entry.data, { flag: 'wx', mode: entry.mode });
      await chmod(path, entry.mode);
    }
  }
  await writeFile(join(root, MARKER), `${JSON.stringify({ owner: OWNER, schema: 1 }, null, 2)}\n`, { flag: 'wx' });
}

export async function readSkill(source = SOURCE): Promise<string> {
  return readFile(join(source, 'SKILL.md'), 'utf8');
}

export async function installSkills(options: InstallSkillsOptions): Promise<{ installations: SkillInstallation[] }> {
  if (options.agent !== 'all' && !AGENTS.includes(options.agent as Agent)) {
    throw new Error('Choose an agent with --agent codex, claude, opencode, pi, or all.');
  }
  const scope = options.scope ?? 'user';
  if (scope !== 'user' && scope !== 'project') throw new Error('Skill scope must be user or project.');
  const agents = options.agent === 'all' ? AGENTS : [options.agent as Agent];
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const env = options.env ?? process.env;
  const source = resolve(options.source ?? SOURCE);
  const sourceEntries = await snapshot(source);
  if (!sourceEntries.some(entry => entry.path === 'SKILL.md' && entry.kind === 'file')) {
    throw new Error(`Bundled skill is missing SKILL.md: ${source}`);
  }
  const sourceReal = await realpath(source);
  const sourceHash = fingerprint(sourceEntries);
  const plans: Plan[] = [];

  // Validate every destination before creating any directories or staging files.
  for (const agent of agents) {
    const path = destination(agent, scope, cwd, home, env);
    const stat = await statOrUndefined(path);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing to install over a symlink: ${path}`);
    const canonical = await canonicalPath(path);
    if (contains(source, path) || contains(path, source) || contains(sourceReal, canonical) || contains(canonical, sourceReal)) {
      throw new Error(`Skill source and installation destination overlap: ${path}`);
    }
    if (plans.some(plan => contains(plan.canonicalPath, canonical) || contains(canonical, plan.canonicalPath))) {
      throw new Error(`Selected agent installation paths overlap: ${path}`);
    }
    const plan: Plan = { agent, scope, path, canonicalPath: canonical, status: 'installed' };
    if (stat) {
      if (!stat.isDirectory()) throw new Error(`Installation destination is not a directory: ${path}`);
      await assertOwned(path);
      plan.originalHash = fingerprint(await snapshot(path));
      if (plan.originalHash === sourceHash) plan.status = 'unchanged';
      else {
        if (!options.force) throw new Error(`NEWS skill already exists with different contents at ${path}. Use --force to replace this NEWS installation.`);
        plan.status = 'updated';
      }
    }
    plans.push(plan);
  }

  const created: string[] = [];
  const pending = plans.filter(plan => plan.status !== 'unchanged');
  try {
    for (const plan of pending) {
      // Work at the resolved location so a symlinked home/config directory is supported.
      await ensureParents(dirname(plan.canonicalPath), created);
      plan.staging = await mkdtemp(join(dirname(plan.canonicalPath), '.news-skill-install-'));
      await writeSnapshot(join(plan.staging, 'new'), sourceEntries);
    }
    for (const plan of pending) {
      if (await canonicalPath(plan.path) !== plan.canonicalPath) throw new Error(`Installation path changed during installation: ${plan.path}`);
      const stat = await statOrUndefined(plan.path);
      if (stat?.isSymbolicLink()) throw new Error(`Installation path became a symlink: ${plan.path}`);
      if (plan.originalHash !== undefined) {
        await assertOwned(plan.path);
        if (fingerprint(await snapshot(plan.path)) !== plan.originalHash) throw new Error(`NEWS skill changed during installation: ${plan.path}`);
        await rename(plan.canonicalPath, join(plan.staging!, 'backup'));
        plan.movedOld = true;
      } else if (stat) {
        throw new Error(`Installation destination appeared during installation: ${plan.path}`);
      }
      await rename(join(plan.staging!, 'new'), plan.canonicalPath);
      plan.installed = true;
    }
  } catch (error) {
    const recovery: string[] = [];
    for (const plan of [...pending].reverse()) {
      try {
        if (plan.installed) await rm(plan.canonicalPath, { recursive: true, force: true });
        if (plan.movedOld) await rename(join(plan.staging!, 'backup'), plan.canonicalPath);
        if (plan.staging) await rm(plan.staging, { recursive: true, force: true });
      } catch {
        if (plan.staging) recovery.push(plan.staging);
      }
    }
    for (const path of [...created].reverse()) {
      try { await rmdir(path); } catch { /* Keep directories if another process has populated them. */ }
    }
    if (recovery.length) throw new Error(`Skill installation failed; previous files are preserved for recovery at ${recovery.join(', ')}.`, { cause: error });
    throw error;
  }
  for (const plan of pending) await rm(plan.staging!, { recursive: true, force: true });
  return { installations: plans.map(({ agent, scope, path, status }) => ({ agent, scope, path, status })) };
}
