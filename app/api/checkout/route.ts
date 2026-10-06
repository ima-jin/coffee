/**
 * POST /api/checkout
 *
 * Creates a Checkout session for one-time or recurring support via pay service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { rateLimit, getClientIP } from '@ima-jin/config';
import { payServiceUrl, publicAppUrl } from '@/lib/env';

const log = createLogger('coffee');

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
    const { amount, recurring, joinMailingList } = await request.json();

    if (!amount || amount < 500) {
      return NextResponse.json({ error: 'Minimum amount is $5' }, { status: 400 });
    }

    const metadata: Record<string, string> = {
      service: 'coffee',
      type: recurring ? 'subscription' : 'checkout',
      joinMailingList: joinMailingList ? 'true' : 'false',
    };

    const baseUrl = publicAppUrl();
    const payRes = await fetch(`${payServiceUrl()}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: recurring ? 'subscription' : 'payment',
        items: [
          {
            name: recurring ? 'Support Imajin (Monthly)' : 'Support Imajin',
            description: recurring
              ? 'Monthly support for sovereign infrastructure development'
              : 'One-time support for sovereign infrastructure development',
            amount,
            quantity: 1,
          },
        ],
        currency: 'USD',
        successUrl: `${baseUrl}/success?type=${recurring ? 'subscription' : 'onetime'}`,
        cancelUrl: baseUrl,
        metadata,
      }),
    });

    if (!payRes.ok) {
      const err = await payRes.text();
      log.error({ err }, 'Pay service checkout failed');
      return NextResponse.json({ error: 'Failed to create checkout' }, { status: 500 });
    }

    const payData = await payRes.json();
    return NextResponse.json({ url: payData.url });
  } catch (error) {
    log.error({ err: String(error) }, 'Checkout error');
    return NextResponse.json({ error: 'Failed to create checkout' }, { status: 500 });
  }
}
