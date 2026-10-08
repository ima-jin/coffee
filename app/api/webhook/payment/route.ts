import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, tips, type Tip } from '@/db';
import { webhookSecret } from '@/lib/env';
import { settleTip } from '@/lib/settle';
import type { PayeeManifest } from '@/lib/tip-manifest';

const log = createLogger('coffee');

/** Constant-time check of the `Authorization: Bearer <WEBHOOK_SECRET>` header. */
function isAuthorized(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(authHeader), digest(`Bearer ${secret}`));
}

/** True when a stored `payee_manifest` has the `{ chain: [...] }` shape settle posts back. */
function isPayeeManifest(value: unknown): value is PayeeManifest {
  return typeof value === 'object' && value !== null && Array.isArray((value as { chain?: unknown }).chain);
}

/**
 * Settle a completed tip's .fair split with the manifest + transaction id recorded at checkout.
 * Idempotent across webhook redelivery: a tip that is already marked settled is not settled
 * again, and a settle the kernel answers `alreadySettled` still counts as success.
 */
async function settleCompletedTip(tip: Tip): Promise<void> {
  if (tip.settledAt) {
    log.info({ tipId: tip.id }, '[webhook] Tip already settled — skipping');
    return;
  }

  if (!tip.payTransactionId || !isPayeeManifest(tip.payeeManifest)) {
    log.warn({ tipId: tip.id }, '[webhook] Cannot settle tip — no pay transactionId / payee manifest recorded at checkout');
    return;
  }

  const outcome = await settleTip({
    tipId: tip.id,
    payTransactionId: tip.payTransactionId,
    manifest: tip.payeeManifest,
  });

  if (outcome === 'settled' || outcome === 'already-settled') {
    await db.update(tips).set({ settledAt: new Date() }).where(eq(tips.id, tip.id));
  }
}

/** Handle a completed payment: mark the tip as completed and settle the .fair split */
async function handlePaymentSucceeded(params: { tipId: string; paymentId: string | undefined }): Promise<void> {
  const { tipId, paymentId } = params;

  // Update tip status
  await db
    .update(tips)
    .set({ status: 'completed', ...(paymentId && { paymentId }) })
    .where(eq(tips.id, tipId));
  log.info({ tipId }, 'Tip completed');

  const tip = await db.query.tips.findFirst({
    where: (t, { eq: equals }) => equals(t.id, tipId),
  });
  if (tip) {
    await settleCompletedTip(tip);
  } else {
    log.warn({ tipId }, '[webhook] Cannot settle tip — tip record not found');
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
    const { type, tipId, paymentId } = await request.json();

    if (!tipId) {
      return Response.json({ received: true }); // Not a tip event
    }

    switch (type) {
      case 'payment.succeeded':
      case 'checkout.completed': {
        await handlePaymentSucceeded({ tipId, paymentId });
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
