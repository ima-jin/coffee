/**
 * Card-rail outcomes from pay's `POST /api/checkout` (ima-jin/imajin-ai#2757, #2773).
 *
 * Stripe Connect is gone: a card tip is charged on the PAGE OWNER'S OWN Stripe account
 * through their BYO connector. An owner with no connected key gets a 400 with the stable
 * `code: "SELLER_NO_CARD_RAIL"`; an owner whose Stripe account would not take the charge
 * gets a 502 with a `CARD_RAIL_*` code; a monthly tip with a seller gets
 * `SUBSCRIPTION_NOT_SUPPORTED`. None is a server fault, so none may surface as a generic
 * "Failed to create payment".
 *
 * Coffee has no e-Transfer path; where the page owner enabled Solana, the form offers it.
 */

/** Pay's stable code when the page owner has no card rail (no connected Stripe key). */
export const SELLER_NO_CARD_RAIL = 'SELLER_NO_CARD_RAIL';

/** The `rail` pay puts on the tip webhook for a payment it already settled on the owner's own Stripe. */
export const STRIPE_BYO_RAIL = 'stripe-byo';

/** What a tipper is told when the page owner has not set up card payments. */
export const NO_CARD_RAIL_MESSAGE =
  "Card payments aren't set up for this page yet. Try another way to tip, or contact the page owner.";

/** What a tipper is told when the owner's Stripe account could not start the charge. */
export const CARD_RAIL_UNAVAILABLE_MESSAGE =
  "Card payment couldn't be started on the page owner's Stripe account. Please try again later or contact the page owner.";

/** What a tipper is told when they ask for a monthly card tip. */
export const SUBSCRIPTION_NOT_SUPPORTED_MESSAGE =
  "Monthly card tips aren't available yet. Please send a one-time tip instead.";

/** Pay's `CARD_RAIL_*` codes: the owner has a key, but their Stripe account would not take the charge. */
const CARD_RAIL_FAILURE_CODES = new Set([
  'CARD_RAIL_KEY_MISSING',
  'CARD_RAIL_KEY_REJECTED',
  'CARD_RAIL_UNAVAILABLE',
  'CARD_RAIL_REQUEST_REJECTED',
]);

export interface CardRailFailure {
  /** Plain, tipper-facing sentence. */
  message: string;
  status: number;
  /** The pay code, passed through so the form can react to it. */
  code: string;
}

/**
 * Map a pay checkout error `code` to a plain tipper-facing failure, or `null` when the code is
 * not a card-rail outcome (the caller then keeps its own handling).
 */
export function cardRailFailure(code: unknown): CardRailFailure | null {
  if (code === SELLER_NO_CARD_RAIL) {
    return { message: NO_CARD_RAIL_MESSAGE, status: 400, code: SELLER_NO_CARD_RAIL };
  }
  if (code === 'SUBSCRIPTION_NOT_SUPPORTED') {
    return { message: SUBSCRIPTION_NOT_SUPPORTED_MESSAGE, status: 400, code };
  }
  if (typeof code === 'string' && CARD_RAIL_FAILURE_CODES.has(code)) {
    return { message: CARD_RAIL_UNAVAILABLE_MESSAGE, status: 502, code };
  }
  return null;
}

/** The `code` of a pay error body, or `undefined` when the body is not JSON or carries none. */
export function payErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') {
      const { code } = parsed as { code?: unknown };
      return typeof code === 'string' ? code : undefined;
    }
  } catch {
    // Not JSON — no code.
  }
  return undefined;
}

export interface TipPayStateInput {
  /** The page enabled card payments. */
  hasStripe: boolean;
  /** The page enabled Solana payments. */
  hasSolana: boolean;
  /** Pay's card-rail check said the owner can take a card payment. */
  sellerConnected: boolean;
  /** Pay refused a card checkout with `SELLER_NO_CARD_RAIL` in this session. */
  cardRefused: boolean;
}

export interface TipPayState {
  /** Show the card option. */
  stripeAvailable: boolean;
  /** The page offers cards but the owner cannot take them: hide the card option, say so plainly. */
  cardMissing: boolean;
  /** At least one payment method can be submitted. */
  canSubmit: boolean;
  /** No payment method is enabled at all. */
  nothingEnabled: boolean;
}

/** Which payment options the tip form shows. */
export function tipPayState(input: TipPayStateInput): TipPayState {
  const { hasStripe, hasSolana, sellerConnected, cardRefused } = input;
  const stripeAvailable = hasStripe && sellerConnected && !cardRefused;
  const cardMissing = hasStripe && !stripeAvailable;
  const canSubmit = stripeAvailable || hasSolana;
  return { stripeAvailable, cardMissing, canSubmit, nothingEnabled: !canSubmit && !cardMissing };
}
