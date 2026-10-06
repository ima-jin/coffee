import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside Next.js, so .env.local isn't auto-loaded — load it
// here rather than adding a `dotenv` dependency just for this one CLI path.
const envPath = '.env.local';
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (process.env[key]) continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// This app owns exactly one Postgres schema: `coffee`. APP_DB_SCHEMA must be set to it
// (see .env.example) so src/db/schema.ts and the committed migrations agree.
const APP_SCHEMA = 'coffee';
if (process.env.APP_DB_SCHEMA !== APP_SCHEMA) {
  throw new Error(
    `APP_DB_SCHEMA must be "${APP_SCHEMA}" (got "${process.env.APP_DB_SCHEMA ?? ''}") — see .env.example and docs/MIGRATIONS.md.`,
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['coffee'],
  // Keep drizzle's migration-tracking table inside this app's own schema, rather than the
  // default shared `drizzle` schema — the app never touches a schema it doesn't own.
  migrations: {
    schema: 'coffee',
    table: '__drizzle_migrations',
  },
});
