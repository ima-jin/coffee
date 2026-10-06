import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs against a database that `pnpm db:migrate` has already been applied to
 * (CI does this in the "Test + build" job). Skipped when TEST_DATABASE_URL is unset,
 * so `pnpm test` still works on a machine without Postgres.
 */
const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)('migrated coffee database', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(connectionString as string, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql.end();
  });

  it('creates the coffee schema', async () => {
    const rows = await sql`select schema_name from information_schema.schemata where schema_name = 'coffee'`;
    expect(rows).toHaveLength(1);
  });

  it('creates only coffee tables, with no tables outside the app schema', async () => {
    const rows = await sql<{ table_schema: string; table_name: string }[]>`
      select table_schema, table_name from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema')
      order by table_schema, table_name`;
    expect(rows.map((row) => `${row.table_schema}.${row.table_name}`)).toEqual([
      'coffee.__drizzle_migrations',
      'coffee.pages',
      'coffee.tips',
    ]);
  });

  it('does not create the shared drizzle tracking schema', async () => {
    const rows = await sql`select schema_name from information_schema.schemata where schema_name = 'drizzle'`;
    expect(rows).toHaveLength(0);
  });

  it('creates the pages and tips indexes', async () => {
    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'coffee' order by indexname`;
    const names = rows.map((row) => row.indexname);
    for (const expected of [
      'idx_coffee_pages_did',
      'idx_coffee_pages_handle',
      'idx_tips_created',
      'idx_tips_page',
      'idx_tips_status',
      'pages_did_unique',
      'pages_handle_unique',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('enforces tips.page_id -> pages.id within the coffee schema', async () => {
    await expect(
      sql`insert into coffee.tips (id, page_id, amount, payment_method, payment_id)
          values ('tip_orphan', 'page_missing', 100, 'stripe', 'pi_test')`,
    ).rejects.toThrow(/tips_page_id_pages_id_fk/);
  });

  it('applies the documented column defaults', async () => {
    await sql`delete from coffee.tips where id = 'tip_default'`;
    await sql`delete from coffee.pages where id = 'page_default'`;
    await sql`insert into coffee.pages (id, did, handle, title, payment_methods)
              values ('page_default', 'did:imajin:test', 'default-handle', 'Test', '{}'::jsonb)`;
    await sql`insert into coffee.tips (id, page_id, amount, payment_method, payment_id)
              values ('tip_default', 'page_default', 500, 'stripe', 'pi_default')`;
    const [page] = await sql`select presets, allow_custom_amount, allow_messages, is_public from coffee.pages where id = 'page_default'`;
    const [tip] = await sql`select currency, status from coffee.tips where id = 'tip_default'`;
    await sql`delete from coffee.tips where id = 'tip_default'`;
    await sql`delete from coffee.pages where id = 'page_default'`;
    expect(page).toEqual({ presets: [100, 500, 1000], allow_custom_amount: true, allow_messages: true, is_public: true });
    expect(tip).toEqual({ currency: 'USD', status: 'pending' });
  });
});
