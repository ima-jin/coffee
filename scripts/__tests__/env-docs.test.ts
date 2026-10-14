import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ENV_VAR_NAMES, ENV_VARS, validateEnv } from '../lib/env-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');
const CHECK_ENV = join(ROOT, 'scripts/check-env.mjs');

function childEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '__tests__', 'coverage', '.git'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function envNamesIn(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) names.add(match[1]);
  return [...names];
}

describe('env contract coverage', () => {
  const manifest = new Set(ENV_VAR_NAMES);
  it('pins both published auth SDK dependencies exactly to 0.8.18', () => {
    const { dependencies } = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(dependencies['@ima-jin/auth']).toBe('0.8.18');
    expect(dependencies['@ima-jin/auth-client']).toBe('0.8.18');
  });

  it('puts the per-environment sealed-secret prerequisite before the deploy commands', () => {
    const docs = read('docs/DEPLOY.md');
    expect(docs.indexOf('## Vault-backed session upgrade prerequisite')).toBeLessThan(docs.indexOf('## The one command'));
    expect(docs).toContain('ima-jin/imajin-ai#2801');
    expect(docs).toContain('**Sync manifest secrets**');
    expect(docs).toContain('SESSION_SECRET unavailable');
    expect(docs).toContain('exits with code 1');
    expect(docs).toContain('dev kernel cannot issue sealed app secrets yet');
    expect(docs).toContain('before upgrading `prod-coffee`');
    expect(docs).toContain('Dev sync does not provision prod');
  });

  it('removes the session credential from all env contracts and operator docs', () => {
    for (const file of [
      '.env.example', '.env.dev.example', '.env.prod.example',
      // check-env and DEPLOY retain names-only cleanup/recovery diagnostics, not env configuration.
      'scripts/lib/env-vars.json', 'scripts/lib/env-manifest.mjs',
      'README.md', 'AGENTS.md',
      ...readdirSync(join(ROOT, 'docs')).filter((file) => file.endsWith('.md') && file !== 'DEPLOY.md').map((file) => `docs/${file}`),
    ]) {
      expect(read(file), file).not.toContain('SESSION_SECRET');
    }
    expect(JSON.parse(read('imajin.app.json')).secrets).toEqual([
      { name: 'SESSION_SECRET', kind: 'random-32B' },
    ]);
  });

  it('has no duplicate manifest entries and every entry is complete', () => {
    expect(manifest.has('SESSION_SECRET')).toBe(false);
    expect(new Set(ENV_VAR_NAMES).size).toBe(ENV_VAR_NAMES.length);
    for (const variable of ENV_VARS) {
      expect(variable.summary.length, variable.name).toBeGreaterThan(10);
      expect(variable.dev, variable.name).toBeTruthy();
      expect(variable.prod, variable.name).toBeTruthy();
    }
  });

  it('documents every variable read by this repo (app, config, scripts)', () => {
    const files = [
      ...walk(join(ROOT, 'app')),
      ...walk(join(ROOT, 'src')),
      ...walk(join(ROOT, 'scripts')),
      join(ROOT, 'instrumentation.ts'),
      join(ROOT, 'next.config.js'),
      join(ROOT, 'drizzle.config.ts'),
      join(ROOT, 'ecosystem.config.cjs'),
    ];
    const undocumented = files.flatMap((file) =>
      envNamesIn(readFileSync(file, 'utf8'))
        .filter((name) => !manifest.has(name))
        .map((name) => `${name} (${file.replace(ROOT, '')})`),
    );
    expect(undocumented).toEqual([]);
  });

  it('documents every variable read by the installed @ima-jin/* packages', () => {
    const base = join(ROOT, 'node_modules/@ima-jin');
    const undocumented: string[] = [];
    for (const pkg of readdirSync(base)) {
      const dist = join(base, pkg, 'dist');
      for (const file of walk(dist)) {
        for (const name of envNamesIn(readFileSync(file, 'utf8'))) {
          // The SDK fallback is explicitly disabled by our empty claimCode
          // boot option; it must not become an app env configuration entry.
          const disabledClaimFallback = pkg === 'auth-client' && name === 'IMAJIN_APP_CLAIM_CODE';
          if (!manifest.has(name) && !disabledClaimFallback) undocumented.push(`${name} (@ima-jin/${pkg})`);
        }
      }
    }
    expect([...new Set(undocumented)]).toEqual([]);
  });

  it('lists every variable in .env.example and docs/ENVIRONMENTS.md', () => {
    const example = read('.env.example');
    const docs = read('docs/ENVIRONMENTS.md');
    for (const name of ENV_VAR_NAMES) {
      expect(example, `.env.example is missing ${name}`).toMatch(new RegExp(`^#?\\s*${name}=|^# ${name}\\b`, 'm'));
      expect(docs, `docs/ENVIRONMENTS.md is missing ${name}`).toContain(`\`${name}\``);
    }
  });

  it('removes IMAJIN_APP_CLAIM_CODE from the env contract, runtime and all operator docs', () => {
    expect(manifest.has('IMAJIN_APP_CLAIM_CODE')).toBe(false);
    const files = [
      '.env.example', '.env.dev.example', '.env.prod.example', 'README.md', 'AGENTS.md',
      // check-env alone retains a names-only cleanup warning for stale env files.
      'instrumentation.ts', 'middleware.ts', 'scripts/deploy.sh',
      'scripts/lib/env-manifest.mjs', 'scripts/lib/env-vars.json',
      ...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'src')),
      ...readdirSync(join(ROOT, 'docs')).filter((file) => file.endsWith('.md')).map((file) => `docs/${file}`),
    ];
    for (const file of files) {
      const source = readFileSync(file.startsWith(ROOT) ? file : join(ROOT, file), 'utf8');
      expect(source, file).not.toContain('IMAJIN_APP_CLAIM_CODE');
    }
  });

  it('shows both a dev and a prod example in docs/ENVIRONMENTS.md', () => {
    const docs = read('docs/ENVIRONMENTS.md');
    expect(docs).toContain('## Dev example');
    expect(docs).toContain('## Prod example');
    expect(docs).toContain(read('.env.dev.example').trim());
    expect(docs).toContain(read('.env.prod.example').trim());
  });

  it('keeps secrets out of every example file', () => {
    for (const file of ['.env.example', '.env.dev.example', '.env.prod.example']) {
      const parsed = parseEnv(read(file));
      for (const variable of ENV_VARS.filter((v) => v.secret)) {
        if (variable.name === 'DATABASE_URL') {
          expect(parsed.DATABASE_URL, file).toContain(':CHANGE_ME@');
        } else {
          // Secrets are either blank or an obvious REPLACE_ME placeholder — never a value.
          expect(['', 'REPLACE_ME'], `${file} ${variable.name}`).toContain(parsed[variable.name] ?? '');
        }
      }
    }
  });
});

describe('validateEnv', () => {
  // Every operator-supplied value in the shipped examples, filled with a plausible stand-in.
  const FILLED = {
    IMAJIN_APP_DID: 'did:imajin:abc123',
    NEXT_PUBLIC_IMAJIN_APP_ID: 'app_abc123',
    DATABASE_URL: 'postgres://coffee:pw@localhost:5432/db',
  };
  const PLACEHOLDER_VARS = ['DATABASE_URL', 'IMAJIN_APP_DID', 'NEXT_PUBLIC_IMAJIN_APP_ID'];

  it.each([
    ['dev', '.env.dev.example'],
    ['prod', '.env.prod.example'],
  ] as const)('rejects the shipped %s example only because of its placeholders', (target, file) => {
    const { errors } = validateEnv(parseEnv(read(file)), target);
    expect(errors.sort()).toEqual(
      PLACEHOLDER_VARS.map((name) => expect.stringContaining(`${name} is still a REPLACE_ME/CHANGE_ME placeholder`)).sort(),
    );
  });

  it('accepts a fully filled-in file for each target', () => {
    for (const [target, file] of [['dev', '.env.dev.example'], ['prod', '.env.prod.example']] as const) {
      const env = { ...parseEnv(read(file)), ...FILLED };
      expect(validateEnv(env, target)).toEqual({ errors: [], warnings: [] });
    }
  });

  const validProd = () => ({ ...parseEnv(read('.env.prod.example')), ...FILLED });
  const validDev = () => ({ ...parseEnv(read('.env.dev.example')), ...FILLED });

  it('reports every missing required variable by name', () => {
    const { errors } = validateEnv({}, 'prod');
    for (const variable of ENV_VARS.filter((v) => v.status === 'required')) {
      expect(errors).toContain(`${variable.name} is required but not set.`);
    }
  });

  it('rejects a raw private key', () => {
    const { errors } = validateEnv({ ...validProd(), IMAJIN_APP_PRIVATE_KEY: 'x' }, 'prod');
    expect(errors.join('\n')).toMatch(/IMAJIN_APP_PRIVATE_KEY must not be set/);
  });

  it('keeps dev and prod apart', () => {
    expect(validateEnv({ ...validProd(), IMAJIN_ENV: 'dev' }, 'prod').errors.join('\n')).toMatch(/IMAJIN_ENV=dev must not be set on prod/);
    expect(validateEnv({ ...validProd(), AUTH_SERVICE_URL: 'https://dev-jin.imajin.ai/auth' }, 'prod').errors.join('\n')).toMatch(/dev host/);
    const devWithoutEnv = { ...validDev(), IMAJIN_ENV: '' };
    expect(validateEnv(devWithoutEnv, 'dev').errors.join('\n')).toMatch(/IMAJIN_ENV must be `dev`/);
    expect(validateEnv({ ...validDev(), IMAJIN_KERNEL_URL: 'https://jin.imajin.ai' }, 'dev').errors.join('\n')).toMatch(/non-dev host/);
  });

  it('rejects localhost kernels, mismatched kernel hosts and a missing /auth prefix', () => {
    expect(validateEnv({ ...validProd(), IMAJIN_KERNEL_URL: 'http://localhost:3000' }, 'prod').errors.join('\n')).toMatch(/localhost/);
    expect(validateEnv({ ...validProd(), NEXT_PUBLIC_KERNEL_URL: 'https://other.imajin.ai' }, 'prod').errors.join('\n')).toMatch(/same kernel host/);
    expect(validateEnv({ ...validProd(), AUTH_SERVICE_URL: 'https://jin.imajin.ai' }, 'prod').errors.join('\n')).toMatch(/\/auth prefix/);
    expect(validateEnv({ ...validProd(), AUTH_SERVICE_URL: 'not a url' }, 'prod').errors.join('\n')).toMatch(/not a valid http/);
  });

  it('rejects a wrong schema, base path, database URL and DID', () => {
    const errors = validateEnv(
      { ...validProd(), APP_DB_SCHEMA: 'other', NEXT_PUBLIC_BASE_PATH: '/x', DATABASE_URL: 'mysql://h/db', IMAJIN_APP_DID: 'abc' },
      'prod',
    ).errors.join('\n');
    expect(errors).toMatch(/APP_DB_SCHEMA must be `coffee`/);
    expect(errors).toMatch(/NEXT_PUBLIC_BASE_PATH must be \/coffee/);
    expect(errors).toMatch(/DATABASE_URL must be a postgres/);
    expect(errors).toMatch(/must start with did:imajin:/);
  });

  it('warns about port and logging leftovers', () => {
    const { errors, warnings } = validateEnv(
      { ...validProd(), PORT: '9999', LOG_DB_TRANSPORT: 'true' },
      'prod',
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/PORT is set/);
    expect(warnings.join('\n')).toMatch(/LOG_DB_TRANSPORT=true/);
  });

  it('throws on an unknown target', () => {
    expect(() => validateEnv({}, 'staging' as never)).toThrow(/Unknown target/);
  });
});

describe('check-env CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffee-check-env-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (args: string[]) => spawnSync(process.execPath, [CHECK_ENV, ...args], { env: childEnv(), encoding: 'utf8', cwd: dir });

  it.each([
    ['dev', '.env.dev.example'],
    ['prod', '.env.prod.example'],
  ] as const)('warns exactly once about an ignored stale claim code on %s, with zero errors and no value echoed', (target, example) => {
    const file = join(dir, 'ok.env');
    const filled = Object.entries({
      ...parseEnv(read(example)),
      IMAJIN_APP_DID: 'did:imajin:abc123',
      NEXT_PUBLIC_IMAJIN_APP_ID: 'app_abc123',
      IMAJIN_APP_CLAIM_CODE: 'FAKE_ENV_CLAIM_CODE',
      DATABASE_URL: 'postgres://coffee:pw@localhost:5432/db',
    });
    writeFileSync(file, filled.map(([name, value]) => `${name}=${value}`).join('\n'));
    const result = cli([target, '--file', file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${file} is valid for ${target}.\n`);
    expect(result.stderr).toBe(
      'warn:  IMAJIN_APP_CLAIM_CODE is ignored — claim at /coffee/claim and delete IMAJIN_APP_CLAIM_CODE from the env file.\n',
    );
    expect(result.stdout + result.stderr).not.toContain('FAKE_ENV_CLAIM_CODE');
  });
  it.each([
    ['dev', '.env.dev.example'],
    ['prod', '.env.prod.example'],
  ] as const)('warns once about an ignored stale session credential on %s without leaking the value', (target, example) => {
    const file = join(dir, 'stale-session.env');
    const filled = {
      ...parseEnv(read(example)),
      IMAJIN_APP_DID: 'did:imajin:abc123',
      NEXT_PUBLIC_IMAJIN_APP_ID: 'app_abc123',
      DATABASE_URL: 'postgres://localhost:5432/db',
    };
    for (const value of ['FAKE_STALE_SESSION_VALUE', '', '   ']) {
      writeFileSync(file, [...Object.entries(filled).map(([name, entry]) => `${name}=${entry}`), `SESSION_SECRET="${value}"`].join('\n'));
      const result = cli([target, '--file', file]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${file} is valid for ${target}.\n`);
      const warning = value.trim()
        ? 'warn:  SESSION_SECRET is ignored; it is issued by the kernel vault. Delete it from the env file.\n'
        : '';
      expect(result.stderr).toBe(warning);
      expect(result.stdout + result.stderr).not.toContain('FAKE_STALE_SESSION_VALUE');
    }
  });

  it('exits 1 for an invalid file without echoing any value', () => {
    const file = join(dir, 'bad.env');
    writeFileSync(file, 'DATABASE_URL=postgres://u:supersecretvalue@h/db\nIMAJIN_APP_PRIVATE_KEY=supersecretkey\n');
    const result = cli(['prod', '--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/IMAJIN_APP_PRIVATE_KEY must not be set/);
    expect(result.stdout + result.stderr).not.toContain('supersecret');
  });

  it('exits 2 on a missing file, an unknown target, and stray arguments', () => {
    expect(cli(['prod', '--file', join(dir, 'nope.env')]).status).toBe(2);
    expect(cli(['staging']).status).toBe(2);
    expect(cli(['prod', '--wat']).status).toBe(2);
  });
});
