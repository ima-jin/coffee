import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ checkAppMigrationsMock: vi.fn() }));

vi.mock('@/lib/migration-status', () => ({
  checkAppMigrations: mocks.checkAppMigrationsMock,
  hasPendingMigrations: (m: { pendingCount: number | null } | undefined) =>
    m != null && m.pendingCount !== null && m.pendingCount > 0,
}));

import { resetSigningIdentityForTests } from '@/lib/signing-identity';
import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  resetSigningIdentityForTests();
});

describe('GET /api/health', () => {
  it('reports ok with this app’s own migration state, and claimed:false before this app has claimed a signing identity', async () => {
    const migrations = { migrationHead: '0000_coffee_schema', appliedCount: 1, pendingCount: 0 };
    mocks.checkAppMigrationsMock.mockResolvedValue(migrations);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', service: 'coffee', version: '0.0.0', build: 'dev', migrations, claimed: false });
    expect(typeof body.timestamp).toBe('string');
  });

  it('reports degraded when migrations are pending', async () => {
    mocks.checkAppMigrationsMock.mockResolvedValue({ migrationHead: 'x', appliedCount: 0, pendingCount: 1 });

    expect((await (await GET()).json()).status).toBe('degraded');
  });

  it('stays ok (never a 500) when the migration state is unknown', async () => {
    mocks.checkAppMigrationsMock.mockResolvedValue({ migrationHead: null, appliedCount: 0, pendingCount: null, error: 'db down' });

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('ok');
  });

  it('surfaces the build metadata from the environment', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', '1.2.3');
    vi.stubEnv('NEXT_PUBLIC_BUILD_HASH', 'abc123');
    mocks.checkAppMigrationsMock.mockResolvedValue({ migrationHead: null, appliedCount: 0, pendingCount: 0 });

    expect(await (await GET()).json()).toMatchObject({ version: '1.2.3', build: 'abc123' });
  });
});
