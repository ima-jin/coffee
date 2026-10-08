import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertIdentifier,
  BaselineMismatchError,
  compareSchema,
  expectedSchema,
  readBaselineMigration,
  runBaseline,
} from '../lib/migrate-baseline-core.mjs';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));
const CLI = fileURLToPath(new URL('../migrate-baseline.mjs', import.meta.url));
const BASELINE_SQL_FILE = `${MIGRATIONS_FOLDER}/0000_coffee_schema.sql`;
const SCHEMA = 'coffee';
const TRACKING = 'coffee.__drizzle_migrations';
// drizzle.config.ts keeps the tracking table in the app schema, so migrate()
// must be pointed at the very same place the CLI uses.
const MIGRATE_OPTIONS = { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: SCHEMA };

/** Number of migrations in the committed journal — what a fully migrated database has recorded. */
function journalEntryCount(): number {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8'));
  return journal.entries.length;
}

type RunnerSql = Parameters<typeof runBaseline>[0];
type Options = { dryRun?: boolean };

function run(sql: unknown, options: Options = {}) {
  return runBaseline(sql as RunnerSql, { schema: SCHEMA, migrationsFolder: MIGRATIONS_FOLDER, ...options });
}

/** Minimal child env — never inherits the caller's DATABASE_URL & friends. */
function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv;
}

describe('assertIdentifier', () => {
  it('accepts plain lower-case identifiers', () => {
    expect(assertIdentifier('coffee', 'x')).toBe('coffee');
    expect(assertIdentifier('app_coffee_2', 'x')).toBe('app_coffee_2');
  });

  it.each(['', 'Coffee', 'coffee; DROP SCHEMA coffee', 'a"b', '1coffee', 'a-b'])('rejects %j', (value) => {
    expect(() => assertIdentifier(value, 'APP_DB_SCHEMA')).toThrow(/APP_DB_SCHEMA must match/);
  });
});

describe('readBaselineMigration', () => {
  it('hashes the first journal entry exactly like drizzle-orm does', async () => {
    const baseline = await readBaselineMigration(MIGRATIONS_FOLDER);
    const [drizzleFirst] = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

    expect(baseline.hash).toBe(drizzleFirst.hash);
    expect(baseline.when).toBe(drizzleFirst.folderMillis);
    expect(baseline.hash).toBe(createHash('sha256').update(readFileSync(BASELINE_SQL_FILE, 'utf8')).digest('hex'));
  });
});

describe('compareSchema', () => {
  const fresh = () => structuredClone(expectedSchema(SCHEMA));

  it('accepts an identical schema', () => {
    expect(compareSchema(fresh(), expectedSchema(SCHEMA))).toEqual([]);
  });

  it('tolerates extra indexes (harmless)', () => {
    const actual = fresh();
    actual.pages.indexes.push({ name: 'idx_extra', columns: ['bio'], method: 'btree' });
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([]);
  });

  it('reports a missing table', () => {
    const actual = fresh() as Record<string, unknown>;
    delete actual.tips;
    expect(compareSchema(actual as ReturnType<typeof expectedSchema>, expectedSchema(SCHEMA))).toEqual([
      'tips: table is missing',
    ]);
  });

  it('reports an unexpected table', () => {
    const actual = { ...fresh(), stray: structuredClone(fresh().tips) };
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual(['stray: unexpected table in the app schema']);
  });

  it('reports missing, extra, retyped, nullability and default drift on columns', () => {
    const actual = fresh();
    delete (actual.pages.columns as Record<string, unknown>).bio;
    (actual.pages.columns as Record<string, unknown>).surprise = { type: 'text', notNull: false, default: null };
    actual.tips.columns.payment_id.type = 'character varying(255)';
    actual.tips.columns.amount.notNull = false;
    actual.tips.columns.status.default = null;

    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([
      'pages.bio: column is missing',
      'pages.surprise: unexpected column',
      'tips.amount: NOT NULL is false, expected true',
      'tips.payment_id: type is character varying(255), expected text',
      "tips.status: default is none, expected 'pending'::text",
    ]);
  });

  it('reports key, FK and index drift', () => {
    const actual = fresh();
    actual.pages.primaryKey = ['did'];
    actual.pages.unique = [['did']];
    actual.tips.foreignKeys[0].onDelete = 'cascade';
    actual.tips.indexes = [];

    const problems = compareSchema(actual, expectedSchema(SCHEMA)).join('\n');
    expect(problems).toMatch(/pages: primary key is \(did\), expected \(id\)/);
    expect(problems).toMatch(/pages: unique constraints/);
    expect(problems).toMatch(/tips: foreign keys/);
    expect(problems).toMatch(/tips: index idx_tips_page is missing/);
    expect(problems).toMatch(/tips: index idx_tips_status is missing/);
    expect(problems).toMatch(/tips: index idx_tips_created is missing/);
  });

  it('reports a reshaped index', () => {
    const actual = fresh();
    actual.tips.indexes[0].columns = ['status'];
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([
      'tips: index idx_tips_page is btree(status), expected btree(page_id)',
    ]);
  });
});

/**
 * The shape the monorepo's shared seed (imajin-ai migrations/0001_seed.sql)
 * left in prod/dev: same tables and constraints as this repo's migration
 * 0000, but with the seed's own column order and PK constraint names.
 */
const PROD_LIKE_SCHEMA_SQL = [
  'CREATE SCHEMA IF NOT EXISTS coffee',
  `CREATE TABLE coffee.pages (
    id text NOT NULL, did text NOT NULL, handle text NOT NULL, title text NOT NULL,
    bio text, avatar text, theme jsonb DEFAULT '{}'::jsonb,
    payment_methods jsonb NOT NULL, presets integer[] DEFAULT '{100,500,1000}'::integer[],
    allow_custom_amount boolean DEFAULT true, allow_messages boolean DEFAULT true,
    is_public boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    fund_directions jsonb DEFAULT '[]'::jsonb, thank_you_content text,
    avatar_asset_id text, fair_manifest jsonb)`,
  `CREATE TABLE coffee.tips (
    id text NOT NULL, page_id text NOT NULL, from_did text, from_name text,
    amount integer NOT NULL, currency text DEFAULT 'USD'::text NOT NULL, message text,
    payment_method text NOT NULL, payment_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(), fund_direction text)`,
  'ALTER TABLE ONLY coffee.pages ADD CONSTRAINT coffee_pages_pkey PRIMARY KEY (id)',
  'ALTER TABLE ONLY coffee.pages ADD CONSTRAINT pages_did_unique UNIQUE (did)',
  'ALTER TABLE ONLY coffee.pages ADD CONSTRAINT pages_handle_unique UNIQUE (handle)',
  'ALTER TABLE ONLY coffee.tips ADD CONSTRAINT tips_pkey PRIMARY KEY (id)',
  'CREATE INDEX idx_coffee_pages_did ON coffee.pages USING btree (did)',
  'CREATE INDEX idx_coffee_pages_handle ON coffee.pages USING btree (handle)',
  'CREATE INDEX idx_tips_created ON coffee.tips USING btree (created_at)',
  'CREATE INDEX idx_tips_page ON coffee.tips USING btree (page_id)',
  'CREATE INDEX idx_tips_status ON coffee.tips USING btree (status)',
  `ALTER TABLE ONLY coffee.tips ADD CONSTRAINT tips_page_id_pages_id_fk
     FOREIGN KEY (page_id) REFERENCES coffee.pages(id)`,
];

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('migrate-baseline against a real Postgres', () => {
  let admin: postgres.Sql;
  let dbName: string;
  let url: string;
  let sql: postgres.Sql;

  beforeEach(async () => {
    admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
    dbName = `coffee_baseline_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const parsed = new URL(databaseUrl as string);
    parsed.pathname = `/${dbName}`;
    url = parsed.toString();
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterEach(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  async function seedProdLike() {
    for (const statement of PROD_LIKE_SCHEMA_SQL) {
      await sql.unsafe(statement);
    }
    await sql.unsafe(
      `INSERT INTO coffee.pages (id, did, handle, title, payment_methods)
       VALUES ('page_1', 'did:imajin:a', 'a', 'Buy A a coffee', '{}'::jsonb)`,
    );
    await sql.unsafe(
      `INSERT INTO coffee.tips (id, page_id, amount, payment_method, payment_id)
       VALUES ('tip_1', 'page_1', 500, 'stripe', 'pi_1')`,
    );
  }

  async function rowCounts() {
    const [row] = await sql.unsafe(
      `SELECT (SELECT count(*) FROM coffee.pages)::int AS pages,
              (SELECT count(*) FROM coffee.tips)::int AS tips`,
    );
    return row;
  }

  async function trackingRows() {
    return sql.unsafe(`SELECT hash, created_at FROM ${TRACKING} ORDER BY id`);
  }

  async function trackingExists() {
    const [row] = await sql.unsafe(`SELECT to_regclass('${TRACKING}') IS NOT NULL AS present`);
    return row.present as boolean;
  }

  /** Wraps the client so every statement the baseline issues can be audited. */
  function recording(statements: string[]) {
    return {
      begin: (fn: (tx: unknown) => Promise<unknown>) =>
        sql.begin((tx) =>
          fn({
            unsafe: (text: string, params?: unknown[]) => {
              statements.push(text);
              return tx.unsafe(text, params as never);
            },
          }),
        ),
    };
  }

  describe('baselining an existing, prod-shaped schema', () => {
    it('records migration 0000 and leaves every table and row untouched', async () => {
      await seedProdLike();
      const before = await rowCounts();
      const expected = await readBaselineMigration(MIGRATIONS_FOLDER);

      const result = await run(sql);

      expect(result).toEqual({ status: 'baselined', tag: expected.tag });
      expect(await rowCounts()).toEqual(before);
      const rows = await trackingRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].hash).toBe(expected.hash);
      expect(Number(rows[0].created_at)).toBe(expected.when);
    });

    it('is idempotent — a second and third run change nothing', async () => {
      await seedProdLike();
      await run(sql);

      const second = await run(sql);
      const third = await run(sql);

      expect(second.status).toBe('already-baselined');
      expect(third.status).toBe('already-baselined');
      expect(await trackingRows()).toHaveLength(1);
      expect(await rowCounts()).toEqual({ pages: 1, tips: 1 });
    });

    it('leaves drizzle migrate to apply only the migrations after 0000 (no CREATE TABLE collision)', async () => {
      await seedProdLike();
      await run(sql);

      await migrate(drizzle(sql), MIGRATE_OPTIONS);

      // Existing data survives, 0000 is not re-run, and every later migration is recorded exactly once.
      expect(await rowCounts()).toEqual({ pages: 1, tips: 1 });
      expect(await trackingRows()).toHaveLength(journalEntryCount());
      const columns = await sql.unsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'coffee' AND table_name = 'tips' AND column_name IN ('pay_transaction_id', 'payee_manifest', 'settled_at')`,
      );
      expect(columns.map((row) => row.column_name).sort()).toEqual(['payee_manifest', 'pay_transaction_id', 'settled_at'].sort());
      const [tip] = await sql.unsafe(`SELECT pay_transaction_id, payee_manifest, settled_at FROM coffee.tips WHERE id = 'tip_1'`);
      expect(tip).toEqual({ pay_transaction_id: null, payee_manifest: null, settled_at: null });

      // A second migrate stays a no-op.
      await migrate(drizzle(sql), MIGRATE_OPTIONS);
      expect(await trackingRows()).toHaveLength(journalEntryCount());
    });

    it('without the baseline, migrate fails on the existing schema (why this script exists)', async () => {
      await seedProdLike();
      await expect(migrate(drizzle(sql), MIGRATE_OPTIONS)).rejects.toThrow();
    });

    it('accepts a schema produced by migration 0000 itself (expectation cannot drift from the SQL)', async () => {
      // Apply ONLY the baseline migration's SQL — the expectation is pinned to 0000, not to later migrations.
      for (const statement of readFileSync(BASELINE_SQL_FILE, 'utf8').split('--> statement-breakpoint')) {
        await sql.unsafe(statement);
      }
      await sql.unsafe(`CREATE TABLE ${TRACKING} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);

      // Valid schema, drizzle has no record of it: must validate and baseline,
      // ignoring the (empty) tracking table that lives in the app schema.
      expect((await run(sql)).status).toBe('baselined');
      expect(await trackingRows()).toHaveLength(1);
      expect((await run(sql)).status).toBe('already-baselined');
    });

    it('dry run validates but writes nothing', async () => {
      await seedProdLike();

      const result = await run(sql, { dryRun: true });

      expect(result.status).toBe('would-baseline');
      expect(await trackingExists()).toBe(false);
    });
  });

  describe('fresh database', () => {
    it('does nothing and creates nothing, leaving the schema to db:migrate', async () => {
      const statements: string[] = [];

      const result = await run(recording(statements));

      expect(result.status).toBe('fresh-database');
      expect(statements.filter((s) => !/^\s*SELECT\b/i.test(s))).toEqual([]);
      expect(await trackingExists()).toBe(false);
      const [schemas] = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'coffee'`);
      expect(schemas.n).toBe(0);
      await migrate(drizzle(sql), MIGRATE_OPTIONS);
      expect((await run(sql)).status).toBe('already-baselined');
    });

    it('treats a schema that holds no tables, or only drizzle\'s empty tracking table, as fresh', async () => {
      await sql.unsafe('CREATE SCHEMA coffee');
      expect((await run(sql)).status).toBe('fresh-database');

      await sql.unsafe(`CREATE TABLE ${TRACKING} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      expect((await run(sql)).status).toBe('fresh-database');

      await migrate(drizzle(sql), MIGRATE_OPTIONS);
      expect((await run(sql)).status).toBe('already-baselined');
    });
  });

  describe('refuses on mismatch', () => {
    async function expectRefusal(pattern: RegExp) {
      const before = await rowCounts();
      await expect(run(sql)).rejects.toBeInstanceOf(BaselineMismatchError);
      await expect(run(sql)).rejects.toThrow(pattern);
      expect(await trackingExists()).toBe(false);
      expect(await rowCounts()).toEqual(before);
    }

    it('when a column is missing', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE coffee.pages DROP COLUMN fair_manifest');
      await expectRefusal(/pages\.fair_manifest: column is missing/);
    });

    it('when a column has an unexpected type', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE coffee.tips ALTER COLUMN payment_id TYPE varchar(100)');
      await expectRefusal(/tips\.payment_id: type is character varying\(100\), expected text/);
    });

    it('when an unknown table lives in the app schema', async () => {
      await seedProdLike();
      await sql.unsafe('CREATE TABLE coffee.stray (id text)');
      await expectRefusal(/stray: unexpected table/);
    });

    it('when a foreign key is missing', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE coffee.tips DROP CONSTRAINT tips_page_id_pages_id_fk');
      await expectRefusal(/tips: foreign keys/);
    });

    it('when a required index is missing', async () => {
      await seedProdLike();
      await sql.unsafe('DROP INDEX coffee.idx_tips_status');
      await expectRefusal(/idx_tips_status is missing/);
    });

    it('when only part of the schema exists', async () => {
      await sql.unsafe('CREATE SCHEMA coffee');
      await sql.unsafe('CREATE TABLE coffee.pages (id text)');
      await expect(run(sql)).rejects.toThrow(/tips: table is missing/);
      expect(await trackingExists()).toBe(false);
    });

    it('when the tracking table holds history that does not include migration 0000', async () => {
      await seedProdLike();
      await sql.unsafe(`CREATE TABLE ${TRACKING} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      await sql.unsafe(`INSERT INTO ${TRACKING} (hash, created_at) VALUES ('someone-elses-hash', 1)`);

      await expect(run(sql)).rejects.toThrow(/unrecognised migration history/);
      expect(await trackingRows()).toHaveLength(1);
    });

    it('when APP_DB_SCHEMA is not a safe identifier', () => {
      expect(() =>
        runBaseline(sql as unknown as RunnerSql, {
          schema: 'coffee; DROP SCHEMA coffee',
          migrationsFolder: MIGRATIONS_FOLDER,
        }),
      ).toThrow(/APP_DB_SCHEMA must match/);
    });
  });

  describe('never drops, truncates, or alters anything', () => {
    const DESTRUCTIVE = /\b(DROP|TRUNCATE|ALTER|DELETE|UPDATE|GRANT|REVOKE|RENAME)\b/i;

    it('only ever issues SELECTs plus create-only bookkeeping DDL (successful run)', async () => {
      await seedProdLike();
      const statements: string[] = [];

      await run(recording(statements));

      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).not.toMatch(DESTRUCTIVE);
        expect(statement).not.toMatch(/\b(pages|tips)\b/i);
      }
      const writes = statements.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s));
      expect(writes).toHaveLength(2);
      expect(writes[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "coffee"\."__drizzle_migrations"/);
      expect(writes[1]).toMatch(/^INSERT INTO "coffee"\."__drizzle_migrations"/);
    });

    it('issues no write at all when it refuses', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE coffee.pages DROP COLUMN bio');
      const statements: string[] = [];

      await expect(run(recording(statements))).rejects.toBeInstanceOf(BaselineMismatchError);

      expect(statements.filter((s) => !/^\s*SELECT\b/i.test(s))).toEqual([]);
    });

    it('issues no write at all on a re-run or a dry run', async () => {
      await seedProdLike();
      const dryRun: string[] = [];
      const options = { schema: SCHEMA, migrationsFolder: MIGRATIONS_FOLDER, dryRun: true };
      await runBaseline(recording(dryRun) as RunnerSql, options);
      await run(sql);
      const rerun: string[] = [];
      await run(recording(rerun));

      expect(dryRun.filter((s) => !/^\s*SELECT\b/i.test(s))).toEqual([]);
      expect(rerun.filter((s) => !/^\s*SELECT\b/i.test(s))).toEqual([]);
    });

    it('can place the tracking table in a separate schema, creating only that schema', async () => {
      await seedProdLike();
      const statements: string[] = [];
      const options = { schema: SCHEMA, migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: 'drizzle' };

      const result = await runBaseline(recording(statements) as RunnerSql, options);

      expect(result.status).toBe('baselined');
      expect(statements.some((s) => s === 'CREATE SCHEMA IF NOT EXISTS "drizzle"')).toBe(true);
      const [row] = await sql.unsafe(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      expect(row.n).toBe(1);
    });
  });

  describe('CLI', () => {
    function cli(env: Record<string, string>, args: string[] = []) {
      return spawnSync(process.execPath, [CLI, ...args], {
        env: childEnv(env),
        encoding: 'utf8',
      });
    }

    it('exits 0 on baseline, then 0 again (idempotent), without echoing the connection string', async () => {
      await seedProdLike();

      const first = cli({ DATABASE_URL: url });
      const second = cli({ DATABASE_URL: url });

      expect(first.status).toBe(0);
      expect(first.stdout).toMatch(/Baselined: recorded 0000_/);
      expect(second.status).toBe(0);
      expect(second.stdout).toMatch(/Already baselined/);
      const output = first.stdout + first.stderr + second.stdout + second.stderr;
      expect(output).not.toContain(new URL(url).password || 'no-password-in-url');
    });

    it('exits 1 with a clear error on mismatch and changes nothing', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE coffee.pages DROP COLUMN bio');

      const result = cli({ DATABASE_URL: url });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Refusing to baseline/);
      expect(result.stderr).toMatch(/pages\.bio: column is missing/);
      expect(await trackingExists()).toBe(false);
    });

    it('--dry-run exits 0 and writes nothing', async () => {
      await seedProdLike();

      const result = cli({ DATABASE_URL: url }, ['--dry-run']);

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Dry run/);
      expect(await trackingExists()).toBe(false);
    });

    it('honours APP_DB_SCHEMA (a schema of that name with no tables is a fresh database)', () => {
      const result = cli({ DATABASE_URL: url, APP_DB_SCHEMA: 'other_app' });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Fresh database/);
    });
  });
});

describe('migrate-baseline CLI configuration errors (no database needed)', () => {
  const cli = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, [CLI, ...args], { env: childEnv(env), encoding: 'utf8' });

  it('exits 2 when DATABASE_URL is missing', () => {
    const result = cli({});
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/DATABASE_URL is not set/);
  });

  it('exits 2 on an unknown argument', () => {
    const result = cli({ DATABASE_URL: 'postgres://127.0.0.1:1/x' }, ['--force']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Unknown argument/);
  });

  it('exits 2 on an unsafe APP_DB_SCHEMA before touching the database', () => {
    const result = cli({ DATABASE_URL: 'postgres://127.0.0.1:1/x', APP_DB_SCHEMA: 'x; DROP SCHEMA y' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/APP_DB_SCHEMA must match/);
  });
});
