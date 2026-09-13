import { readFileSync } from 'node:fs';

// The build copies only this metadata into the installed, self-contained skill.
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_API_URL = 'https://xabcnews.com';
