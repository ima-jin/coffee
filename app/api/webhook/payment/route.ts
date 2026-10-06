import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, tips } from '@/db';
import { webhookSecret } from '@/lib/env';
import { settleTip } from '@/lib/settle';

const log = createLogger('coffee');

/** Constant-time check of the `Authorization: Bearer <WEBHOOK_SECRET>` header. */
function isAuthorized(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(authHeader), digest(`Bearer ${secret}`));
}

/** Resolve the recipient DID for the coffee page a tip was sent to */
async function resolveRecipientDid(toDid: string | undefined, pageId: string | undefined): Promise<string | undefined> {
  if (toDid || !pageId) return toDid;
  const page = await db.query.coffeePages.findFirst({
    where: (pages, { eq }) => eq(pages.id, pageId),
  });
  return page?.did;
}

/** Fall back to the tip record's stored amount when the webhook payload didn't include one */
async function resolveTipAmount(tipId: string): Promise<number | undefined> {
  const tip = await db.query.tips.findFirst({
    where: (t, { eq }) => eq(t.id, tipId),
  });
  return tip?.amount;
}

/** Handle a completed payment: mark the tip as completed and settle the .fair split */
async function handlePaymentSucceeded(params: {
  tipId: string;
  paymentId: string | undefined;
  amount: number | undefined;
  fromDid: string | undefined;
  to_did: string | undefined;
  pageId: string | undefined;
  stripeSessionId: string | undefined;
}): Promise<void> {
  const { tipId, paymentId, amount, fromDid, to_did: toDid, pageId, stripeSessionId } = params;

  // Update tip status
  await db
    .update(tips)
    .set({ status: 'completed', ...(paymentId && { paymentId }) })
    .where(eq(tips.id, tipId));
  log.info({ tipId }, 'Tip completed');

  const recipientDid = await resolveRecipientDid(toDid, pageId);

  // Resolve tip amount — prefer webhook payload, fall back to tip record
  const tipAmount = amount || (await resolveTipAmount(tipId));

  // Settle the .fair split
  if (recipientDid && tipAmount) {
    await settleTip({
      tipId,
      recipientDid,
      fromDid: fromDid || null,
      amount: tipAmount,
      currency: 'USD',
      stripeSessionId,
    });
  } else {
    log.warn({ tipId }, '[webhook] Cannot settle tip — missing recipientDid or amount');
  }

  // The kernel version also published `tip.granted` / `tip.sent` to the
  // in-process event bus here. No public HTTP surface exists for that yet —
  // see docs/ARCHITECTURE.md (gap(kernel)).
}

/**
 * POST /api/webhook/payment - Receives payment callbacks from pay service
 */
export async function POST(request: NextRequest) {
  const secret = webhookSecret();
  if (!secret) {
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  if (!isAuthorized(request.headers.get('authorization'), secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { type, tipId, paymentId, amount, fromDid, to_did, pageId, stripeSessionId } = await request.json();

    if (!tipId) {
      return Response.json({ received: true }); // Not a tip event
    }

    switch (type) {
      case 'payment.succeeded':
      case 'checkout.completed': {
        await handlePaymentSucceeded({ tipId, paymentId, amount, fromDid, to_did, pageId, stripeSessionId });
        break;
      }

      case 'payment.failed': {
        await db.update(tips).set({ status: 'failed' }).where(eq(tips.id, tipId));
        log.info({ tipId }, 'Tip failed');
        break;
      }

      default:
        log.info({ type }, 'Unhandled coffee webhook type');
    }

    return Response.json({ received: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Coffee webhook handler error');
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
