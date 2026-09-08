import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  AppConfigSchema,
  LexiconSchema,
  TestDataSchema,
  type AppConfig,
  type Lexicon,
  type TestDataConfig,
} from './schema.js';

/**
 * Absolute path to the project root, independent of the working directory.
 *
 * Located by walking up to the nearest `package.json` rather than by a fixed
 * number of `..` segments, so it resolves correctly both when run from source
 * via tsx (`src/config/`) and from the compiled build (`dist/src/config/`).
 */
function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();

export const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
export const AUTH_DIR = path.join(PROJECT_ROOT, 'auth', '.storage');

async function readYaml(file: string): Promise<unknown> {
  const raw = await readFile(file, 'utf8');
  return YAML.parse(raw);
}

/** Loads and validates one application's configuration by slug. */
export async function loadAppConfig(appName: string): Promise<AppConfig> {
  const file = path.join(CONFIG_DIR, 'apps', `${appName}.yaml`);
  if (!existsSync(file)) {
    throw new Error(
      `No config found for app "${appName}".\nExpected: ${file}\n` +
        `Create it, or copy config/apps/example.yaml as a starting point.`,
    );
  }
  const parsed = await readYaml(file);
  const result = AppConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config in ${file}:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}

/** Loads the global label lexicon; returns an empty lexicon when absent. */
export async function loadLexicon(): Promise<Lexicon> {
  const file = path.join(CONFIG_DIR, 'lexicon.yaml');
  if (!existsSync(file)) return { canonical: {} };
  return LexiconSchema.parse(await readYaml(file));
}

/** Loads the global dummy-data rules; returns empty rules when absent. */
export async function loadTestData(): Promise<TestDataConfig> {
  const file = path.join(CONFIG_DIR, 'testdata.yaml');
  if (!existsSync(file)) return { byKind: {}, byLabel: {} };
  return TestDataSchema.parse(await readYaml(file));
}

/** Resolves where a version's saved browser session lives. */
export function storageStatePath(app: AppConfig, version: 'old' | 'new'): string {
  const configured = app.versions[version]?.storageState;
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.join(PROJECT_ROOT, configured);
  }
  return path.join(AUTH_DIR, `${app.name}-${version}.json`);
}

/** Returns the version config, failing clearly when it is not defined. */
export function requireVersion(app: AppConfig, version: 'old' | 'new') {
  const cfg = app.versions[version];
  if (!cfg) {
    throw new Error(
      `App "${app.name}" has no "${version}" version configured. ` +
        `Add versions.${version}.url to config/apps/${app.name}.yaml.`,
    );
  }
  return cfg;
}
