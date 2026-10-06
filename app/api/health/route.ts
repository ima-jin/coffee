import { NextResponse } from 'next/server';
import { isAppClaimed } from '@/lib/signing-identity';
import { checkAppMigrations, hasPendingMigrations } from '@/lib/migration-status';

export const dynamic = 'force-dynamic';

/**
 * This app is master of its own schema: its own `/api/health` reports its own
 * migration state from its own DB connection (never another service's).
 */
export async function GET() {
  const migrations = await checkAppMigrations();

  return NextResponse.json({
    status: hasPendingMigrations(migrations) ? 'degraded' : 'ok',
    service: 'coffee',
    version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
    build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
    timestamp: new Date().toISOString(),
    migrations,
    // Unclaimed boot mode (#2427): false until an operator pastes a claim
    // code at /claim (or IMAJIN_APP_CLAIM_CODE resolves it at boot).
    claimed: isAppClaimed(),
  });
}
