import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@ima-jin/ui', () => ({ MarkdownContent: 'MarkdownContent' }));

import SuccessPage from '../page';

const props = (searchParams: { type?: string; handle?: string } = {}) => ({
  searchParams: Promise.resolve(searchParams),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetchMock);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('SuccessPage', () => {
  it('shows the default one-time thank-you without looking up a creator', async () => {
    const json = JSON.stringify(await SuccessPage(props()));

    expect(json).toContain('Thank you!');
    expect(json).toContain('Your support means the world. Every contribution');
    expect(json).not.toContain('monthly support');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('shows the subscription copy for monthly support', async () => {
    const json = JSON.stringify(await SuccessPage(props({ type: 'subscription' })));

    expect(json).toContain('Your monthly support means the world');
  });

  it("renders the creator's custom thank-you markdown from their public page", async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ thankYouContent: '**Thanks a lot**' }) });

    const json = JSON.stringify(await SuccessPage(props({ handle: 'creator' })));

    expect(mocks.fetchMock).toHaveBeenCalledWith('https://coffee.test/api/pages/creator', { cache: 'no-store' });
    expect(json).toContain('**Thanks a lot**');
    expect(json).not.toContain('Every contribution');
  });

  it('ignores blank custom content', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ thankYouContent: '   ' }) });

    const json = JSON.stringify(await SuccessPage(props({ handle: 'creator' })));

    expect(json).toContain('Every contribution');
  });

  it.each([
    ['a non-OK response', () => mocks.fetchMock.mockResolvedValue({ ok: false })],
    ['a network failure', () => mocks.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))],
  ])('falls back to the default copy on %s', async (_label, arrange) => {
    arrange();

    const json = JSON.stringify(await SuccessPage(props({ handle: 'creator' })));

    expect(json).toContain('Thank you!');
    expect(json).toContain('Every contribution');
  });
});
