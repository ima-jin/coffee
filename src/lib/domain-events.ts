import { createLogger } from '@ima-jin/logger';
import { AppServiceTokenError, getAppServiceToken, resetAppServiceTokenCache } from '@/lib/app-service-token';
import { kernelUrl } from '@/lib/env';

const log = createLogger('coffee');
const PUBLISH_TIMEOUT_MS = 5_000;

export interface DomainEvent {
  type: 'tip.granted' | 'tip.sent';
  subject: string;
  payload: Record<string, unknown>;
  correlationId: string;
}

/**
 * App-origin events can notify and audit only; the kernel fixes issuer/scope.
 * Await the bounded attempt after committing state, never a detached promise.
 * No retries: the events endpoint does not promise idempotent delivery.
 */
export async function publishDomainEvent(event: DomainEvent): Promise<boolean> {
  const context = { type: event.type, correlationId: event.correlationId };
  let stage = 'configuration';
  try {
    const baseUrl = kernelUrl();
    if (!process.env.IMAJIN_APP_DID) {
      log.error({ ...context, setting: 'IMAJIN_APP_DID' }, '[events] Missing required setting (non-fatal)');
      return false;
    }
    stage = 'token';
    const token = await getAppServiceToken();
    stage = 'publish';
    const response = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      redirect: 'error',
    });
    if (response.ok) {
      log.info(context, '[events] Kernel accepted domain event');
      return true;
    }
    if (response.status === 401) resetAppServiceTokenCache();
    log.error({ ...context, stage, status: response.status }, '[events] Kernel refused domain event (non-fatal); check token, emittableEvents approval or rate limit');
  } catch (error) {
    // Never log arbitrary response bodies, transport errors, tokens or signatures.
    if (stage === 'configuration') {
      log.error({ ...context, setting: 'IMAJIN_KERNEL_URL' }, '[events] Missing required setting (non-fatal)');
    } else if (error instanceof AppServiceTokenError) {
      if (error.status === 401) resetAppServiceTokenCache();
      log.error({ ...context, stage, status: error.status }, '[events] App-service token mint refused (non-fatal)');
    } else {
      log.error({ ...context, stage }, '[events] Delivery failed (non-fatal); check IMAJIN_KERNEL_URL, IMAJIN_APP_DID and claimed IMAJIN_APP_KEYSTORE identity');
    }
  }
  return false;
}
