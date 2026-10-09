import { describe, expect, it } from 'vitest';
import {
  CARD_RAIL_UNAVAILABLE_MESSAGE,
  NO_CARD_RAIL_MESSAGE,
  SUBSCRIPTION_NOT_SUPPORTED_MESSAGE,
  cardRailFailure,
  payErrorCode,
  tipPayState,
} from '../card-rail';

describe('cardRailFailure (#2773)', () => {
  it('maps SELLER_NO_CARD_RAIL to a plain 400', () => {
    expect(cardRailFailure('SELLER_NO_CARD_RAIL')).toEqual({
      message: NO_CARD_RAIL_MESSAGE,
      status: 400,
      code: 'SELLER_NO_CARD_RAIL',
    });
  });

  it('maps SUBSCRIPTION_NOT_SUPPORTED to a plain 400', () => {
    expect(cardRailFailure('SUBSCRIPTION_NOT_SUPPORTED')).toEqual({
      message: SUBSCRIPTION_NOT_SUPPORTED_MESSAGE,
      status: 400,
      code: 'SUBSCRIPTION_NOT_SUPPORTED',
    });
  });

  it.each(['CARD_RAIL_KEY_MISSING', 'CARD_RAIL_KEY_REJECTED', 'CARD_RAIL_UNAVAILABLE', 'CARD_RAIL_REQUEST_REJECTED'])(
    'maps %s to a plain 502 and keeps the code',
    (code) => {
      expect(cardRailFailure(code)).toEqual({ message: CARD_RAIL_UNAVAILABLE_MESSAGE, status: 502, code });
    },
  );

  it.each([undefined, null, '', 'CARD_RAIL_SOMETHING_NEW', 502, {}])('returns null for %j', (code) => {
    expect(cardRailFailure(code)).toBeNull();
  });

  it('never uses the generic checkout failure wording', () => {
    for (const message of [NO_CARD_RAIL_MESSAGE, CARD_RAIL_UNAVAILABLE_MESSAGE, SUBSCRIPTION_NOT_SUPPORTED_MESSAGE]) {
      expect(message).not.toMatch(/unable to start checkout|failed to create/i);
    }
  });
});

describe('payErrorCode', () => {
  it('reads the code from a JSON error body', () => {
    expect(payErrorCode('{"error":"x","code":"SELLER_NO_CARD_RAIL"}')).toBe('SELLER_NO_CARD_RAIL');
  });

  it.each(['', 'card declined', '<html>bad gateway</html>', '{}', '{"code":42}', 'null', '"text"', '[]'])(
    'returns undefined for %j',
    (body) => {
      expect(payErrorCode(body)).toBeUndefined();
    },
  );
});

describe('tipPayState', () => {
  const base = { hasStripe: true, hasSolana: false, sellerConnected: true, cardRefused: false };

  it('shows the card option for a page with cards and a connected owner', () => {
    expect(tipPayState(base)).toEqual({ stripeAvailable: true, cardMissing: false, canSubmit: true, nothingEnabled: false });
  });

  it('hides the card option and says so when the owner has no card rail', () => {
    expect(tipPayState({ ...base, sellerConnected: false })).toEqual({
      stripeAvailable: false,
      cardMissing: true,
      canSubmit: false,
      nothingEnabled: false,
    });
  });

  it('hides the card option after pay refuses a card checkout, even though the page check said connected', () => {
    expect(tipPayState({ ...base, cardRefused: true })).toMatchObject({ stripeAvailable: false, cardMissing: true });
  });

  it('keeps Solana submittable when the card option is hidden', () => {
    expect(tipPayState({ ...base, hasSolana: true, sellerConnected: false })).toEqual({
      stripeAvailable: false,
      cardMissing: true,
      canSubmit: true,
      nothingEnabled: false,
    });
  });

  it('says payments are not available only when no method is enabled', () => {
    expect(tipPayState({ ...base, hasStripe: false })).toEqual({
      stripeAvailable: false,
      cardMissing: false,
      canSubmit: false,
      nothingEnabled: true,
    });
    expect(tipPayState({ ...base, hasStripe: false, hasSolana: true })).toMatchObject({ canSubmit: true, nothingEnabled: false });
  });
});
