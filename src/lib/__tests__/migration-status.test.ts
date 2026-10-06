import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('@/db', () => ({ db: { execute: mocks.executeMock } }));

import { checkAppMigrations, hasPendingMigrations, readJournalTags } from '../migration-status';

let workdir: string;
let cwd: string;

function writeJournal(tags: string[]): void {
  mkdirSync(join(workdir, 'migrations', 'meta'), { recursive: true });
  writeFileSync(
    join(workdir, 'migrations', 'meta', '_journal.json'),
    JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  workdir = mkdtempSync(join(tmpdir(), 'coffee-migrations-'));
  cwd = process.cwd();
  vi.spyOn(process, 'cwd').mockReturnValue(workdir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workdir, { recursive: true, force: true });
  expect(process.cwd()).toBe(cwd);
});

describe('readJournalTags', () => {
  it('lists migration tags in journal order', () => {
    writeJournal(['0000_a', '0001_b']);

    expect(readJournalTags()).toEqual(['0000_a', '0001_b']);
  });
});

describe('checkAppMigrations', () => {
  it('reports no pending migrations when drizzle has applied them all', async () => {
    writeJournal(['0000_a', '0001_b']);
    mocks.executeMock.mockResolvedValueOnce([{ reg: 'drizzle.__drizzle_migrations' }]).mockResolvedValueOnce([{ count: '2' }]);

    expect(await checkAppMigrations()).toEqual({ migrationHead: '0001_b', appliedCount: 2, pendingCount: 0 });
  });

  it('counts committed-but-unapplied migrations as pending', async () => {
    writeJournal(['0000_a', '0001_b']);
    mocks.executeMock.mockResolvedValueOnce([{ reg: 'drizzle.__drizzle_migrations' }]).mockResolvedValueOnce([{ count: '1' }]);

    expect(await checkAppMigrations()).toEqual({ migrationHead: '0001_b', appliedCount: 1, pendingCount: 1 });
  });

  it('treats a missing tracking table as nothing applied yet', async () => {
    writeJournal(['0000_a']);
    mocks.executeMock.mockResolvedValueOnce([{ reg: null }]);

    expect(await checkAppMigrations()).toEqual({ migrationHead: '0000_a', appliedCount: 0, pendingCount: 1 });
  });

  it('degrades to an error shape when the database is unreachable', async () => {
    mocks.executeMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    expect(await checkAppMigrations()).toEqual({
      migrationHead: null,
      appliedCount: 0,
      pendingCount: null,
      error: 'ECONNREFUSED',
    });
  });

  it('reports an unknown error message for non-Error rejections', async () => {
    mocks.executeMock.mockRejectedValueOnce('boom');

    expect((await checkAppMigrations()).error).toBe('Unknown error');
  });

  it('reports pendingCount null (never a guess) when the journal is unreadable', async () => {
    mocks.executeMock.mockResolvedValueOnce([{ reg: 'x' }]).mockResolvedValueOnce([{ count: '3' }]);

    expect(await checkAppMigrations()).toEqual({ migrationHead: null, appliedCount: 3, pendingCount: null });
  });
});

describe('hasPendingMigrations', () => {
  it('is true only for a known positive pending count', () => {
    expect(hasPendingMigrations({ migrationHead: 'x', appliedCount: 0, pendingCount: 2 })).toBe(true);
    expect(hasPendingMigrations({ migrationHead: 'x', appliedCount: 1, pendingCount: 0 })).toBe(false);
    expect(hasPendingMigrations({ migrationHead: null, appliedCount: 0, pendingCount: null })).toBe(false);
    expect(hasPendingMigrations(undefined)).toBe(false);
  });
});
