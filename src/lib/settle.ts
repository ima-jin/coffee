import { createLogger } from '@ima-jin/logger';
import { AppServiceTokenError, getAppServiceToken, resetAppServiceTokenCache } from '@/lib/app-service-token';
import { payServiceUrl } from '@/lib/env';
import type { PayeeManifest } from '@/lib/tip-manifest';

const log = createLogger('coffee');

/**
 * settleTip
 *
 * Settles a tip's .fair split via the registered-app contract of the kernel's
 * pay service: `POST {pay}/api/settle` authenticated with coffee's OWN
 * app-service token (`src/lib/app-service-token.ts`), body
 * `{ transaction_id, fair_manifest: { chain } }`.
 *
 * `transaction_id` is the id the app-authenticated checkout returned; the
 * payer, amount, currency, rail and service come from the kernel's own record
 * (the payer of an app checkout is recorded as anonymous — never post a
 * `from_did`). The posted chain must equal the payee manifest recorded at
 * checkout, which is why the caller passes the manifest stored on the tip.
 *
 * Settlement failure is non-fatal for the webhook — the tip is already
 * recorded — so every failure is logged and reported as an outcome instead of
 * thrown. Retries are safe: a payment that is already settled answers
 * `alreadySettled: true`, which counts as success.
 */

export type SettleOutcome =
  /** The kernel settled the payment on this call. */
  | 'settled'
  /** An earlier call already settled it (`alreadySettled: true`) — success. */
  | 'already-settled'
  /** 409: the rail has not confirmed the payment yet; retry later. */
  | 'not-completed'
  /** 401/403/404/…: the kernel refused; a retry will not help until something changes. */
  | 'rejected'
  /** Network failure, mint failure, or a 5xx — transient. */
  | 'failed';

interface SettleTipParams {
  tipId: string;
  /** The `transactionId` returned by the app-authenticated checkout. */
  payTransactionId: string;
  /** The payee manifest declared at checkout, posted back verbatim. */
  manifest: PayeeManifest;
}

interface SettleResponseBody {
  alreadySettled?: boolean;
}

async function mintToken(tipId: string): Promise<string | null> {
  try {
    return await getAppServiceToken();
  } catch (error) {
    const detail = error instanceof AppServiceTokenError ? error.message : String(error);
    log.error({ tipId, err: detail }, '[settle] could not mint app-service token (non-fatal)');
    return null;
  }
}

async function classify(tipId: string, response: Response): Promise<SettleOutcome> {
  if (response.ok) {
    const result = (await response.json()) as SettleResponseBody;
    if (result.alreadySettled) {
      log.info({ tipId }, '[settle] Tip was already settled');
      return 'already-settled';
    }
    log.info({ tipId, result }, '[settle] Tip settlement complete');
    return 'settled';
  }

  const text = await response.text();
  if (response.status === 409) {
    log.warn({ tipId, text }, '[settle] payment not completed yet — settle later');
    return 'not-completed';
  }
  if (response.status === 401) {
    // The cached token may have been revoked — remint on the next attempt.
    resetAppServiceTokenCache();
  }
  log.error({ tipId, status: response.status, text }, '[settle] pay /api/settle returned error');
  return response.status >= 500 ? 'failed' : 'rejected';
}

export async function settleTip(params: SettleTipParams): Promise<SettleOutcome> {
  const { tipId, payTransactionId, manifest } = params;

  const token = await mintToken(tipId);
  if (!token) return 'failed';

  try {
    const response = await fetch(`${payServiceUrl()}/api/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        transaction_id: payTransactionId,
        fair_manifest: { chain: manifest.chain },
      }),
    });
    return await classify(tipId, response);
  } catch (error) {
    log.error({ tipId, err: String(error) }, '[settle] Tip settlement request failed (non-fatal)');
    return 'failed';
  }
}
