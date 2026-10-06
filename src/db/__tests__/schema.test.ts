import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadSchema() {
  vi.resetModules();
  return import('../schema');
}

describe('coffee schema', () => {
  it('puts every table in the coffee schema and nowhere else', async () => {
    vi.stubEnv('APP_DB_SCHEMA', 'coffee');
    const { coffeePages, tips } = await loadSchema();
    expect(getTableConfig(coffeePages).schema).toBe('coffee');
    expect(getTableConfig(tips).schema).toBe('coffee');
  });

  it('defines pages and tips tables', async () => {
    vi.stubEnv('APP_DB_SCHEMA', 'coffee');
    const { coffeePages, tips } = await loadSchema();
    expect(getTableConfig(coffeePages).name).toBe('pages');
    expect(getTableConfig(tips).name).toBe('tips');
  });

  it('keeps the kernel column set for pages', async () => {
    vi.stubEnv('APP_DB_SCHEMA', 'coffee');
    const { coffeePages } = await loadSchema();
    const columns = getTableConfig(coffeePages).columns.map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'did',
      'handle',
      'title',
      'bio',
      'avatar',
      'avatar_asset_id',
      'theme',
      'payment_methods',
      'presets',
      'fund_directions',
      'thank_you_content',
      'allow_custom_amount',
      'allow_messages',
      'is_public',
      'fair_manifest',
      'created_at',
      'updated_at',
    ]);
  });

  it('keeps the kernel column set for tips', async () => {
    vi.stubEnv('APP_DB_SCHEMA', 'coffee');
    const { tips } = await loadSchema();
    const columns = getTableConfig(tips).columns.map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'page_id',
      'from_did',
      'from_name',
      'amount',
      'currency',
      'message',
      'fund_direction',
      'payment_method',
      'payment_id',
      'status',
      'created_at',
    ]);
  });

  it('references tips.page_id -> pages.id inside the same schema', async () => {
    vi.stubEnv('APP_DB_SCHEMA', 'coffee');
    const { tips } = await loadSchema();
    const [foreignKey] = getTableConfig(tips).foreignKeys;
    const reference = foreignKey.reference();
    expect(reference.columns.map((column) => column.name)).toEqual(['page_id']);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual(['id']);
    expect(getTableConfig(reference.foreignTable).schema).toBe('coffee');
  });

  it('declares the kernel indexes', async () => {
    vi.stubEnv('APP_DB_SCHEMA', 'coffee');
    const { coffeePages, tips } = await loadSchema();
    const pageIndexes = getTableConfig(coffeePages).indexes.map((index) => index.config.name);
    const tipIndexes = getTableConfig(tips).indexes.map((index) => index.config.name);
    expect(pageIndexes).toEqual(['idx_coffee_pages_handle', 'idx_coffee_pages_did']);
    expect(tipIndexes).toEqual(['idx_tips_page', 'idx_tips_status', 'idx_tips_created']);
  });

  it('throws when APP_DB_SCHEMA is not set', async () => {
    vi.stubEnv('APP_DB_SCHEMA', '');
    await expect(loadSchema()).rejects.toThrow('APP_DB_SCHEMA is not set');
  });
});
