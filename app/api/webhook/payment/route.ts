import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { KernelWebhookError, verifyKernelWebhook } from '@ima-jin/auth/kernel-webhook';
import { createLogger } from '@ima-jin/logger';
import { db, tips, type Tip } from '@/db';
import { STRIPE_BYO_RAIL } from '@/lib/card-rail';
import { settleTip } from '@/lib/settle';
import type { PayeeManifest } from '@/lib/tip-manifest';
import { publishDomainEvent } from '@/lib/domain-events';

const log = createLogger('coffee');

interface PaymentCallback {
  type: string;
  tipId?: string;
  paymentId?: string;
  rail?: string;
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
async function settleCompletedTip(tip: Tip, rail: string | undefined): Promise<void> {
  if (tip.settledAt) {
    log.info({ tipId: tip.id }, '[webhook] Tip already settled — skipping');
    return;
  }

  // #2773: paid on the page owner's OWN Stripe account. The kernel already completed the payment and told
  // us, so this notification IS the settlement — `/pay/api/settle` refuses such a payment (409), which
  // `settleTip` would misread as "not completed yet". Nothing was distributed: the money never touched the platform.
  if (rail === STRIPE_BYO_RAIL) {
    await db.update(tips).set({ settledAt: new Date() }).where(eq(tips.id, tip.id));
    log.info({ tipId: tip.id }, '[webhook] Tip paid on the owner\'s own Stripe account — nothing to settle on-platform');
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

/** Notify using stored tip/page data, never identity or amount claims from the callback. */
async function publishTipNotifications(tip: Tip): Promise<void> {
  try {
    const page = await db.query.coffeePages.findFirst({
      where: (p, { eq: equals }) => equals(p.id, tip.pageId),
    });
    const payload = {
      amount: tip.amount, currency: tip.currency, context_id: tip.id,
      context_type: 'coffee', status: 'completed',
    };
    if (page) {
      await publishDomainEvent({
        type: 'tip.granted', subject: page.did, correlationId: tip.id,
        payload: { ...payload, interestDids: [page.did], tipperName: tip.fromName || 'Anonymous' },
      });
    } else {
      log.error({ tipId: tip.id }, '[events] Recipient page missing; tip.granted could not be delivered');
    }
    if (tip.fromDid) {
      await publishDomainEvent({
        type: 'tip.sent', subject: tip.fromDid, correlationId: tip.id,
        payload: { ...payload, interestDids: [tip.fromDid], pageName: page?.title || 'a creator' },
      });
    }
  } catch {
    log.error({ tipId: tip.id }, '[events] Notification preparation failed (non-fatal)');
  }
}

/** Handle a completed payment: commit completion, notify, then settle the .fair split. */
async function handlePaymentSucceeded(params: {
  tipId: string;
  paymentId: string | undefined;
  rail: string | undefined;
}): Promise<void> {
  const { tipId, paymentId, rail } = params;

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
    await publishTipNotifications(tip);
    await settleCompletedTip(tip, rail);
  } else {
    log.warn({ tipId }, '[webhook] Cannot settle tip — tip record not found');
  }
}

/**
 * POST /api/webhook/payment - Receives payment callbacks from pay service
 */
export async function POST(request: NextRequest) {
  let callback: PaymentCallback;
  try {
    // The SDK authenticates the exact bytes before JSON parsing and atomically
    // consumes the nonce. Never derive the expected audience from the request.
    callback = await verifyKernelWebhook<PaymentCallback>(request, {
      audience: process.env.IMAJIN_APP_DID ?? '',
      authServiceUrl: process.env.AUTH_SERVICE_URL,
    });
  } catch (error) {
    if (!(error instanceof KernelWebhookError) || ['STORE', 'DISCOVERY', 'TRUST'].includes(error.code)) {
      return Response.json({ error: 'Webhook verification unavailable' }, { status: 503 });
    }
    if (error.code === 'INVALID_BODY') {
      return Response.json({ error: 'Invalid webhook body' }, { status: 400 });
    }
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { type, tipId, paymentId, rail } = callback;

    if (!tipId) {
      return Response.json({ received: true }); // Not a tip event
    }

    switch (type) {
      case 'payment.succeeded':
      case 'checkout.completed': {
        await handlePaymentSucceeded({ tipId, paymentId, rail });
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
