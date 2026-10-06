import { createLogger } from '@ima-jin/logger';
import { payServiceUrl } from '@/lib/env';

const log = createLogger('coffee');

/**
 * settleTip
 *
 * Calls POST /api/settle on the kernel's pay service after a tip payment
 * completes. Settlement failure is non-fatal — the tip has already been
 * recorded.
 *
 * `/api/settle` is service-to-service: it authenticates with the pay
 * service's shared API key (`PAY_SERVICE_API_KEY`, env only — never in
 * code), not with a scoped app token. That is a kernel gap, filed as
 * ima-jin/imajin-ai (gap(kernel), refs #1984) — see docs/ARCHITECTURE.md.
 */

interface SettleTipParams {
  tipId: string;
  recipientDid: string;
  fromDid: string | null;
  amount: number; // cents
  currency: string;
  stripeSessionId?: string;
}

export async function settleTip(params: SettleTipParams): Promise<void> {
  const { tipId, recipientDid, fromDid, amount, stripeSessionId } = params;

  const apiKey = process.env.PAY_SERVICE_API_KEY;
  if (!apiKey) {
    log.error({ tipId }, '[settle] PAY_SERVICE_API_KEY is not set — skipping settlement (non-fatal)');
    return;
  }

  const platformDid = process.env.PLATFORM_DID || 'did:imajin:platform';
  const platformFeePercent = Number.parseFloat(process.env.PLATFORM_FEE_PERCENT || '1.5');

  const totalDollars = amount / 100;
  const platformAmount = Number.parseFloat((totalDollars * (platformFeePercent / 100)).toFixed(2));
  const creatorAmount = Number.parseFloat((totalDollars - platformAmount).toFixed(2));

  const chain = [
    { did: recipientDid, amount: creatorAmount, role: 'creator' },
    { did: platformDid, amount: platformAmount, role: 'platform' },
  ];

  const body = {
    from_did: fromDid || 'anonymous',
    total_amount: totalDollars,
    service: 'coffee',
    type: 'tip',
    funded: true,
    funded_provider: 'stripe',
    fair_manifest: { chain },
    metadata: {
      tipId,
      ...(stripeSessionId && { stripeSessionId }),
    },
  };

  try {
    const response = await fetch(`${payServiceUrl()}/api/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status, text }, '[settle] pay /api/settle returned error');
      return;
    }

    const result = await response.json();
    log.info({ tipId, result }, '[settle] Tip settlement complete');
  } catch (error) {
    log.error({ err: String(error) }, '[settle] Tip settlement request failed (non-fatal)');
  }
}
