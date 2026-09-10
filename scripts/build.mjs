import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../skills/news/scripts/', import.meta.url);
await rm(output, { recursive: true, force: true });
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir(new URL('../skills/news/', import.meta.url), { recursive: true });
await writeFile(new URL('../skills/news/package.json', import.meta.url), `${JSON.stringify({ name: 'news', version: pkg.version, private: true, type: 'module' }, null, 2)}\n`);
await chmod(new URL('news.js', output), 0o755);
