import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  fetchMock: vi.fn(),
  tipFormMock: vi.fn(() => null),
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFoundMock }));
vi.mock('@/db', () => ({ db: { query: { coffeePages: { findFirst: mocks.findFirstMock } } } }));
vi.mock('../tip-form', () => ({ default: mocks.tipFormMock }));

import CoffeePage, { generateMetadata } from '../page';

/** Recursively search an (unrendered) React element tree for an element whose `type` matches. */
type AnyElement = ReactElement<Record<string, unknown> & { children?: unknown; page?: unknown; sellerConnected?: boolean; primaryColor?: string }>;

function findElementByType(node: unknown, type: unknown): AnyElement | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as AnyElement;
  if (el.type === type) return el;
  const children = (el.props as { children?: unknown } | undefined)?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    const found = findElementByType(child, type);
    if (found) return found;
  }
  return null;
}

const PAGE = {
  handle: 'creator',
  isPublic: true,
  did: 'did:imajin:creator',
  title: 'Creator Page',
  bio: null,
  avatar: null,
  theme: {},
  presets: [300, 500, 1000],
  fundDirections: null,
  allowCustomAmount: true,
  allowMessages: true,
  paymentMethods: {},
};

const props = (handle = 'creator') => ({ params: Promise.resolve({ handle }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetchMock);
  vi.stubEnv('PAY_SERVICE_URL', 'https://kernel.test/pay');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  mocks.findFirstMock.mockResolvedValue(PAGE);
  mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ cardEnabled: true }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('CoffeePage — page lookup', () => {
  it('404s for an unknown handle', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);

    await expect(CoffeePage(props())).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('404s for a private page', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, isPublic: false });

    await expect(CoffeePage(props())).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it.each(['favicon', 'logo.svg', 'robots.txt'])('404s for leaked static-file request %s without a database lookup', async (handle) => {
    await expect(CoffeePage(props(handle))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.findFirstMock).not.toHaveBeenCalled();
  });
});

describe('CoffeePage — seller-connected check', () => {
  it("asks the pay service whether the owner has a card rail (their own Stripe key) and passes sellerConnected=true to TipForm", async () => {
    const element = await CoffeePage(props());

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      `https://kernel.test/pay/api/card-rail/check?did=${encodeURIComponent(PAGE.did)}`,
      { cache: 'no-store' },
    );
    // The Connect route is gone (ima-jin/imajin-ai#2757): it must never be called.
    expect(String(mocks.fetchMock.mock.calls[0]![0])).not.toContain('/connect/');
    const tipForm = findElementByType(element, mocks.tipFormMock);
    expect(tipForm).not.toBeNull();
    expect(tipForm!.props.sellerConnected).toBe(true);
    expect(tipForm!.props.page).toMatchObject({ handle: 'creator', presets: [300, 500, 1000], paymentMethods: {} });
  });

  it('passes sellerConnected=false when the owner has no card rail', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ cardEnabled: false }) });

    const tipForm = findElementByType(await CoffeePage(props()), mocks.tipFormMock);

    expect(tipForm!.props.sellerConnected).toBe(false);
  });

  it('treats a response without cardEnabled as not connected', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    const tipForm = findElementByType(await CoffeePage(props()), mocks.tipFormMock);

    expect(tipForm!.props.sellerConnected).toBe(false);
  });

  it('keeps sellerConnected=true when the check throws (never blocks tips on error)', async () => {
    mocks.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const tipForm = findElementByType(await CoffeePage(props()), mocks.tipFormMock);

    expect(tipForm!.props.sellerConnected).toBe(true);
  });

  it('keeps sellerConnected=true when PAY_SERVICE_URL is not configured', async () => {
    vi.stubEnv('PAY_SERVICE_URL', '');

    const tipForm = findElementByType(await CoffeePage(props()), mocks.tipFormMock);

    expect(tipForm!.props.sellerConnected).toBe(true);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps sellerConnected=true when the check responds non-OK', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const tipForm = findElementByType(await CoffeePage(props()), mocks.tipFormMock);

    expect(tipForm!.props.sellerConnected).toBe(true);
  });

  it('falls back to default presets and flags when the page leaves them unset', async () => {
    mocks.findFirstMock.mockResolvedValue({
      ...PAGE,
      presets: null,
      allowCustomAmount: null,
      allowMessages: null,
      paymentMethods: null,
      fundDirections: [{ id: 'fd_1', label: 'Rent', description: 'Keep the lights on' }],
    });

    const tipForm = findElementByType(await CoffeePage(props()), mocks.tipFormMock);

    expect(tipForm!.props.page).toEqual({
      handle: 'creator',
      presets: [300, 500, 1000],
      fundDirections: [{ id: 'fd_1', label: 'Rent', description: 'Keep the lights on' }],
      allowCustomAmount: true,
      allowMessages: true,
      paymentMethods: {},
    });
  });
});

describe('CoffeePage — rendering', () => {
  it('renders the avatar emoji, title and bio with the page theme', async () => {
    mocks.findFirstMock.mockResolvedValue({
      ...PAGE,
      avatar: '🎨',
      bio: 'I make things',
      theme: { backgroundColor: '#000', primaryColor: '#f00' },
    });

    const element = await CoffeePage(props());
    const json = JSON.stringify(element);

    expect(json).toContain('🎨');
    expect(json).toContain('I make things');
    expect(json).toContain('#000');
    expect(findElementByType(element, mocks.tipFormMock)!.props.primaryColor).toBe('#f00');
  });

  it('renders an <img> for URL avatars and defaults to the coffee cup otherwise', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, avatar: 'https://cdn.test/a.png' });
    const withImage = JSON.stringify(await CoffeePage(props()));
    mocks.findFirstMock.mockResolvedValue(PAGE);
    const withDefault = JSON.stringify(await CoffeePage(props()));

    expect(withImage).toContain('"type":"img"');
    expect(withImage).toContain('https://cdn.test/a.png');
    expect(withDefault).not.toContain('"type":"img"');
    expect(withDefault).toContain('☕');
  });
});

describe('generateMetadata', () => {
  it('returns generic metadata for a missing or private page', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);
    expect(await generateMetadata(props())).toEqual({ title: 'Coffee | Imajin' });

    mocks.findFirstMock.mockResolvedValue({ ...PAGE, isPublic: false });
    expect(await generateMetadata(props())).toEqual({ title: 'Coffee | Imajin' });
  });

  it('builds OpenGraph/Twitter metadata from the page and this app’s public URL', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, bio: 'I make things' });

    const metadata = await generateMetadata(props());

    expect(metadata).toMatchObject({
      title: 'Creator Page | Coffee | Imajin',
      description: 'I make things',
      openGraph: { url: 'https://coffee.test/creator', type: 'profile', siteName: 'Imajin' },
      twitter: { card: 'summary' },
    });
    expect(metadata.openGraph).not.toHaveProperty('images');
  });

  it('falls back to a default description and uses an absolute avatar URL as the share image', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, avatar: 'https://cdn.test/a.png' });

    const metadata = await generateMetadata(props());

    expect(metadata.description).toBe('Support this creator on the Imajin network');
    expect(metadata.openGraph).toMatchObject({ images: [{ url: 'https://cdn.test/a.png' }] });
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image', images: ['https://cdn.test/a.png'] });
  });

  it('absolutizes a root-relative avatar path against the public app URL', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, avatar: '/uploads/a.png' });

    const metadata = await generateMetadata(props());

    expect(metadata.openGraph).toMatchObject({ images: [{ url: 'https://coffee.test/uploads/a.png' }] });
  });
});
