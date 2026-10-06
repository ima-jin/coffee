import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '@/db';

/**
 * This app's own migration state, reported by its own `/api/health`.
 * `pendingCount` is `null` (never a number derived from partial data) when it
 * cannot be determined, so a caller never mistakes "unknown" for "caught up".
 */
export interface MigrationStatus {
  /** `tag` of the latest committed migration in `migrations/meta/_journal.json`, or `null`. */
  migrationHead: string | null;
  /** Count of migrations recorded as applied in drizzle's own tracking table. */
  appliedCount: number;
  /** Committed migrations not yet applied, or `null` if unknown. */
  pendingCount: number | null;
  /** Present only when the check failed outright. */
  error?: string;
}

/** Counts the migrations committed to this repo (`migrations/meta/_journal.json`). */
export function readJournalTags(migrationsDir = join(process.cwd(), 'migrations')): string[] {
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf-8')) as {
    entries?: Array<{ tag: string }>;
  };
  return (journal.entries ?? []).map((entry) => entry.tag);
}

/** Rows in drizzle-kit's own `drizzle.__drizzle_migrations` table; none if it doesn't exist yet. */
async function countAppliedMigrations(): Promise<number> {
  const existence = await db.execute<{ reg: string | null }>(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS reg`,
  );
  if (!existence[0]?.reg) return 0;
  const rows = await db.execute<{ count: string }>(sql`SELECT count(*) AS count FROM drizzle.__drizzle_migrations`);
  return Number(rows[0]?.count ?? 0);
}

/** Never throws — a failure degrades into an error shape so health can always render JSON. */
export async function checkAppMigrations(): Promise<MigrationStatus> {
  let appliedCount: number;
  try {
    appliedCount = await countAppliedMigrations();
  } catch (error) {
    return {
      migrationHead: null,
      appliedCount: 0,
      pendingCount: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  try {
    const tags = readJournalTags();
    return {
      migrationHead: tags.at(-1) ?? null,
      appliedCount,
      pendingCount: Math.max(tags.length - appliedCount, 0),
    };
  } catch {
    return { migrationHead: null, appliedCount, pendingCount: null };
  }
}

/** True only when `migrations` reports a known, positive pending count. */
export function hasPendingMigrations(migrations: MigrationStatus | undefined): boolean {
  return migrations != null && migrations.pendingCount !== null && migrations.pendingCount > 0;
}
