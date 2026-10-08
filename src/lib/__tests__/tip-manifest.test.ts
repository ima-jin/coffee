import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTipPayeeManifest } from '../tip-manifest';

beforeEach(() => {
  vi.stubEnv('PLATFORM_DID', '');
  vi.stubEnv('PLATFORM_FEE_PERCENT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildTipPayeeManifest', () => {
  it('splits a tip into creator + 1.5% platform fee by default (dollars)', () => {
    expect(buildTipPayeeManifest('did:imajin:creator', 1000)).toEqual({
      chain: [
        { did: 'did:imajin:creator', role: 'creator', amount: 9.85 },
        { did: 'did:imajin:platform', role: 'platform', amount: 0.15 },
      ],
    });
  });

  it('honours PLATFORM_DID / PLATFORM_FEE_PERCENT', () => {
    vi.stubEnv('PLATFORM_DID', 'did:imajin:node');
    vi.stubEnv('PLATFORM_FEE_PERCENT', '10');

    expect(buildTipPayeeManifest('did:imajin:creator', 1000).chain).toEqual([
      { did: 'did:imajin:creator', role: 'creator', amount: 9 },
      { did: 'did:imajin:node', role: 'platform', amount: 1 },
    ]);
  });

  it.each([100, 333, 500, 1234, 9999])('chain amounts sum to the tip total (%i cents)', (cents) => {
    const total = buildTipPayeeManifest('did:imajin:creator', cents).chain.reduce((sum, entry) => sum + entry.amount, 0);

    expect(total).toBeCloseTo(cents / 100, 2);
  });
});
