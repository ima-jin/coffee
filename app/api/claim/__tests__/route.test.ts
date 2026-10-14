import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapSigningIdentity, isAppClaimed, resetSigningIdentityForTests } from '@/lib/signing-identity';
import { resetClaimRateLimitForTests } from '@/lib/claim-rate-limit';
import { middleware } from '../../../../middleware';
import { NextRequest } from 'next/server';
import { POST } from '../route';

const KERNEL_URL = 'https://dev-jin.imajin.test';
const RATE_LIMIT = 5;

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function mockKernelClaim(responseBody: Record<string, unknown>, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(responseBody), { status, headers: { 'Content-Type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('POST /api/claim', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'imajin-claim-route-'));
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', join(workDir, 'keystore.json'));
    vi.stubEnv('IMAJIN_APP_DID', '');
  });

  afterEach(async () => {
    resetSigningIdentityForTests();
    resetClaimRateLimitForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  it('redeems a valid claim code, persists a 0600 keystore, and never returns the private key', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/coffee');
    await bootstrapSigningIdentity();
    expect(isAppClaimed()).toBe(false);
    const request = new NextRequest('http://localhost:3000/');
    const unclaimed = middleware(request);
    expect(await unclaimed.text()).toContain('href="/coffee/claim"');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockKernelClaim({
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    const response = await POST(postRequest({ claimCode: 'FAKE_BROWSER_CLAIM_CODE' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ appDid: 'did:imajin:app-under-test', publicKey: 'signing-public-key-hex' });
    expect(body.privateKey).toBeUndefined();

    const keystoreStat = await stat(join(workDir, 'keystore.json'));
    expect(keystoreStat.mode & 0o777).toBe(0o600);
    expect(isAppClaimed()).toBe(true);
    expect(middleware(request).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(new NextRequest('http://localhost:3000/claim')).status).toBe(404);
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects a missing claim code without calling the kernel', async () => {
    const fetchMock = mockKernelClaim({});

    const response = await POST(postRequest({}) as never);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a kernel refusal to a generic 400 without leaking the kernel error body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockKernelClaim({ error: 'Kernel echoed FAKE_SPENT_CLAIM_CODE and FAKE_PRIVATE_KEY' }, 410);

    const response = await POST(postRequest({ claimCode: 'FAKE_SPENT_CLAIM_CODE' }) as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Unable to redeem this claim code');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('POST /api/claim: claim exchange failed');
  });

  it('404s once this app is already claimed', async () => {
    mockKernelClaim({
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });
    await POST(postRequest({ claimCode: 'FAKE_FIRST_CLAIM_CODE' }) as never);

    const response = await POST(postRequest({ claimCode: 'FAKE_SECOND_CLAIM_CODE' }) as never);

    expect(response.status).toBe(404);
  });

  it('rate-limits repeated attempts from the same client', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(postRequest({ claimCode: `FAKE_CLAIM_ATTEMPT_${attempt}` }, { 'x-forwarded-for': '203.0.113.5' }) as never);
    }
    const response = await POST(
      postRequest({ claimCode: 'FAKE_EXTRA_CLAIM_CODE' }, { 'x-forwarded-for': '203.0.113.5' }) as never
    );

    expect(response.status).toBe(429);
  });

  it('keys the rate limit on the trusted LAST X-Forwarded-For hop, not the spoofable leading one', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    // A different, attacker-controlled leading hop on every request, but the
    // same trailing hop — the one this app's own front-door proxy actually
    // appends. If the limiter (still, wrongly) keyed on the first hop, this
    // loop would never trip the limit at all.
    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(
        postRequest({ claimCode: `FAKE_CLAIM_ATTEMPT_${attempt}` }, { 'x-forwarded-for': `10.0.0.${attempt}, 203.0.113.5` }) as never
      );
    }
    const response = await POST(
      postRequest({ claimCode: 'FAKE_EXTRA_CLAIM_CODE' }, { 'x-forwarded-for': '10.0.0.99, 203.0.113.5' }) as never
    );

    expect(response.status).toBe(429);
  });

  it('ignores a spoofed x-real-ip header and still rate-limits by last XFF hop', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    // A fresh fabricated x-real-ip on every request, but the same trailing
    // x-forwarded-for hop. If the limiter trusted x-real-ip, every request
    // would land in its own bucket and this loop would never trip the limit.
    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(
        postRequest(
          { claimCode: `FAKE_CLAIM_ATTEMPT_${attempt}` },
          { 'x-real-ip': `198.51.100.${attempt}`, 'x-forwarded-for': '203.0.113.5' }
        ) as never
      );
    }
    const response = await POST(
      postRequest(
        { claimCode: 'FAKE_EXTRA_CLAIM_CODE' },
        { 'x-real-ip': '198.51.100.99', 'x-forwarded-for': '203.0.113.5' }
      ) as never
    );

    expect(response.status).toBe(429);
  });

  it('refuses a claim whose kernel-returned appDid does not match IMAJIN_APP_DID, and persists nothing', async () => {
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:this-app');
    mockKernelClaim({
      appDid: 'did:imajin:a-different-app',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    const response = await POST(postRequest({ claimCode: 'FAKE_BROWSER_CLAIM_CODE' }) as never);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.expectedAppDid).toBe('did:imajin:this-app');
    expect(body.claimedAppDid).toBe('did:imajin:a-different-app');
    expect(body.error).not.toContain('FAKE_BROWSER_CLAIM_CODE');
    expect(existsSync(join(workDir, 'keystore.json'))).toBe(false);
  });
});
