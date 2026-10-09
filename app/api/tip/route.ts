import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { rateLimit, getClientIP } from '@ima-jin/config';
import { db, tips, type CoffeePage } from '@/db';
import { getAppServiceToken } from '@/lib/app-service-token';
import { cardRailFailure, payErrorCode } from '@/lib/card-rail';
import { optionalCallerDid } from '@/lib/auth/authenticate';
import { payServiceUrl, publicAppUrl } from '@/lib/env';
import { buildTipPayeeManifest } from '@/lib/tip-manifest';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';

const log = createLogger('coffee');

interface TipRequestBody {
  pageHandle?: string;
  amount?: number;
  paymentMethod?: string;
}

interface PaymentMethods {
  stripe?: { enabled?: boolean };
  solana?: { enabled?: boolean; address?: string };
}

/** Validate the basic shape of a tip request body. Returns an error message, or null when valid. */
function validateTipRequestBody(body: TipRequestBody): string | null {
  const { pageHandle, amount, paymentMethod } = body;

  if (!pageHandle) {
    return 'pageHandle is required';
  }

  if (!amount || amount < 100) {
    return 'amount must be at least 100 cents ($1)';
  }

  if (!paymentMethod || !['stripe', 'solana'].includes(paymentMethod)) {
    return 'paymentMethod must be stripe or solana';
  }

  return null;
}

/** Validate that a coffee page can accept this tip request (visibility, payment method, messages) */
function validatePageForTip(
  page: CoffeePage,
  paymentMethod: string,
  message: string | undefined,
): { message: string; status?: number } | null {
  if (!page.isPublic) {
    return { message: 'This page is not accepting tips', status: 403 };
  }

  // Check if payment method is enabled
  const methods = page.paymentMethods as PaymentMethods | null;
  if (paymentMethod === 'stripe' && !methods?.stripe?.enabled) {
    return { message: 'Card payments not enabled for this page' };
  }
  if (paymentMethod === 'solana' && !methods?.solana?.enabled) {
    return { message: 'Solana payments not enabled for this page' };
  }

  // Check message permission
  if (message && !page.allowMessages) {
    return { message: 'This page does not accept messages with tips' };
  }

  return null;
}

/** Create a pending tip and start a Stripe Checkout session for it */
async function createStripeTip(params: {
  tipId: string;
  page: CoffeePage;
  amount: number;
  currency: string;
  message: string | undefined;
  fromName: string | undefined;
  fromDid: string | null;
  fundDirection: string | undefined;
  recurring: boolean | undefined;
  pageHandle: string;
}) {
  const { tipId, page, amount, currency, message, fromName, fromDid, fundDirection, recurring, pageHandle } = params;
  const appUrl = publicAppUrl();

  // Checkout as this app: the app-service token binds the payment to coffee's DID
  // (pay.transactions.app_did) and the declared payee manifest is what settle later verifies.
  const appToken = await getAppServiceToken();
  const payeeManifest = buildTipPayeeManifest(page.did, amount);

  // Use Stripe Checkout (redirect flow) via pay service
  const payRes = await fetch(`${payServiceUrl()}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appToken}` },
    body: JSON.stringify({
      sellerDid: page.did,
      payeeManifest,
      items: [
        {
          name: `Tip for ${page.title || page.handle}`,
          description: message ? `"${message}" — ${fromName || 'Anonymous'}` : `From ${fromName || 'Anonymous'}`,
          amount,
          quantity: 1,
        },
      ],
      currency: currency.toUpperCase(),
      mode: recurring ? 'subscription' : 'payment',
      successUrl: `${appUrl}/success?handle=${pageHandle}${recurring ? '&type=subscription' : ''}`,
      cancelUrl: `${appUrl}/${pageHandle}`,
      metadata: {
        service: 'coffee',
        type: 'tip',
        tipId,
        pageId: page.id,
        pageHandle: page.handle,
        to_did: page.did,
        fromDid: fromDid || 'anonymous',
        fromName: fromName || 'Anonymous',
        message: message || '',
        ...(fundDirection ? { fundDirection } : {}),
      },
    }),
  });

  if (!payRes.ok) {
    const err = await payRes.text();
    // #2773: no card rail / a Stripe account that would not take the charge / a monthly tip with a seller are
    // not server faults — answer plainly and pass the code through so the form can hide the card option.
    const railFailure = cardRailFailure(payErrorCode(err));
    if (railFailure) {
      log.warn({ code: railFailure.code, tipId }, 'Page owner has no working card rail');
      return Response.json({ error: railFailure.message, code: railFailure.code }, { status: railFailure.status });
    }
    log.error({ err }, 'Pay service checkout failed');
    return errorResponse('Failed to create payment', 500);
  }

  const payData = await payRes.json();
  if (!payData.transactionId) {
    log.warn({ tipId }, 'Pay checkout returned no transactionId — this tip cannot be settled');
  }

  // Insert pending tip
  await db.insert(tips).values({
    id: tipId,
    pageId: page.id,
    fromDid,
    fromName: fromName || null,
    amount,
    currency,
    message: message || null,
    paymentMethod: 'stripe',
    paymentId: payData.id,
    payTransactionId: payData.transactionId ?? null,
    payeeManifest,
    status: 'pending',
  });

  // Return checkout URL for redirect
  return jsonResponse({
    tipId,
    url: payData.url,
    paymentMethod: 'stripe',
  });
}

/** Create a pending tip to be settled via a direct Solana transfer */
async function createSolanaTip(params: {
  tipId: string;
  page: CoffeePage;
  amount: number;
  fromName: string | undefined;
  fromDid: string | null;
  message: string | undefined;
}) {
  const { tipId, page, amount, fromName, fromDid, message } = params;
  const methods = page.paymentMethods as PaymentMethods;
  // For Solana, return the destination address
  const solanaAddress = methods.solana?.address;

  await db.insert(tips).values({
    id: tipId,
    pageId: page.id,
    fromDid,
    fromName: fromName || null,
    amount,
    currency: 'SOL',
    message: message || null,
    paymentMethod: 'solana',
    paymentId: 'pending',
    status: 'pending',
  });

  return jsonResponse({
    tipId,
    solanaAddress,
    amount,
    paymentMethod: 'solana',
  });
}

/**
 * POST /api/tip - Send a tip via Stripe Checkout
 *
 * Public: anonymous callers may tip. When the caller presents a scoped app
 * token (or a session), the tip is attributed to their DID.
 *
 * Note: the kernel version also published `tip.granted` to the in-process
 * event bus here. The bus is kernel-internal and has no public HTTP surface,
 * so this app does not emit it — see docs/ARCHITECTURE.md (gap(kernel)).
 *
 * Body:
 * - pageHandle: string (required)
 * - amount: number in cents (required)
 * - currency: string (default: 'USD')
 * - paymentMethod: 'stripe' | 'solana' (required)
 * - message?: string
 * - fromName?: string (for anonymous tips)
 * - fundDirection?: string
 * - recurring?: boolean
 */
export async function POST(request: NextRequest) {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return errorResponse(`Too many requests. Retry after ${rl.retryAfter}s`, 429);
  }

  try {
    const body = await request.json();
    const {
      pageHandle,
      amount,
      currency = 'USD',
      paymentMethod,
      message,
      fromName,
      fundDirection,
      recurring,
    } = body;

    // Validate required fields
    const validationError = validateTipRequestBody(body);
    if (validationError) {
      return errorResponse(validationError);
    }

    // Get coffee page
    const page = await db.query.coffeePages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, pageHandle),
    });

    if (!page) {
      return errorResponse('Coffee page not found', 404);
    }

    const pageError = validatePageForTip(page, paymentMethod, message);
    if (pageError) {
      return errorResponse(pageError.message, pageError.status);
    }

    // Get sender identity if authenticated
    const fromDid = await optionalCallerDid(request);

    // Create tip record (pending)
    const tipId = generateId('tip');

    if (paymentMethod === 'stripe') {
      return await createStripeTip({
        tipId,
        page,
        amount,
        currency,
        message,
        fromName,
        fromDid,
        fundDirection,
        recurring,
        pageHandle,
      });
    }

    return await createSolanaTip({ tipId, page, amount, fromName, fromDid, message });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create tip');
    return errorResponse('Failed to process tip', 500);
  }
}
