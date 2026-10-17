/**
 * POST /api/checkout
 *
 * Creates a Checkout session for one-time or recurring support via pay service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { rateLimit, getClientIP } from '@ima-jin/config';
import { payServiceUrl, publicAppUrl } from '@/lib/env';
import { optionalAuthenticate, authErrorResponse } from '@/lib/auth/authenticate';
import { db } from '@/db';
import { getAppServiceToken } from '@/lib/app-service-token';

const log = createLogger('coffee');

function supportItem(amount: number, recurring: boolean) {
  return {
    name: recurring ? 'Support Imajin (Monthly)' : 'Support Imajin',
    description: recurring
      ? 'Monthly support for sovereign infrastructure development'
      : 'One-time support for sovereign infrastructure development',
    amount,
    quantity: 1,
  };
}

export async function POST(request: NextRequest) {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    const authResult = await optionalAuthenticate(request);
    if ('error' in authResult) return authErrorResponse(authResult);
    const { pageHandle, amount, recurring, joinMailingList } = await request.json();

    if (!Number.isSafeInteger(amount) || amount < 500) {
      return NextResponse.json({ error: 'Amount must be an integer in cents (minimum $5)' }, { status: 400 });
    }
    if (typeof pageHandle !== 'string' || !pageHandle.trim()) {
      return NextResponse.json({ error: 'pageHandle is required' }, { status: 400 });
    }

    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, pageHandle),
    });
    if (!page) {
      return NextResponse.json({ error: 'Coffee page not found' }, { status: 404 });
    }
    if (!page.isPublic) {
      return NextResponse.json({ error: 'This page is not accepting support' }, { status: 403 });
    }

    const appToken = await getAppServiceToken().catch(() => null);
    if (!appToken) {
      return NextResponse.json({ error: 'Payment service unavailable; please retry checkout' }, { status: 503 });
    }

    const metadata: Record<string, string> = {
      service: 'coffee',
      type: recurring ? 'subscription' : 'checkout',
      joinMailingList: joinMailingList ? 'true' : 'false',
    };

    const baseUrl = publicAppUrl();
    const payRes = await fetch(`${payServiceUrl()}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appToken}` },
      body: JSON.stringify({
        sellerDid: page.did,
        mode: recurring ? 'subscription' : 'payment',
        items: [supportItem(amount, recurring)],
        currency: 'USD',
        successUrl: `${baseUrl}/success?type=${recurring ? 'subscription' : 'onetime'}`,
        cancelUrl: baseUrl,
        metadata,
      }),
    });

    if (!payRes.ok) {
      log.error({ status: payRes.status }, 'Pay service checkout failed');
      return NextResponse.json({ error: 'Failed to create checkout' }, { status: 500 });
    }

    const payData = await payRes.json();
    return NextResponse.json({ url: payData.url });
  } catch {
    log.error({}, 'Checkout error');
    return NextResponse.json({ error: 'Failed to create checkout' }, { status: 500 });
  }
}
