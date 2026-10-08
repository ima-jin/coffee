/**
 * The payee manifest a tip declares at checkout and later settles against.
 *
 * Chain amounts are dollars (the kernel's settle shape). The manifest is built
 * once at checkout, recorded by the kernel (`pay.transactions.payee_manifest`)
 * and stored on the tip row — settlement posts that stored chain verbatim, so a
 * `PLATFORM_FEE_PERCENT` change between checkout and webhook can never make the
 * posted chain differ from the recorded one (the kernel answers 403 on any mismatch).
 */

export interface PayeeChainEntry {
  did: string;
  role: string;
  amount: number;
}

export interface PayeeManifest {
  chain: PayeeChainEntry[];
}

const DEFAULT_PLATFORM_DID = 'did:imajin:platform';
const DEFAULT_PLATFORM_FEE_PERCENT = '1.5';

/** creator + platform split of a tip of `amountCents`. */
export function buildTipPayeeManifest(recipientDid: string, amountCents: number): PayeeManifest {
  const platformDid = process.env.PLATFORM_DID || DEFAULT_PLATFORM_DID;
  const platformFeePercent = Number.parseFloat(process.env.PLATFORM_FEE_PERCENT || DEFAULT_PLATFORM_FEE_PERCENT);

  const totalDollars = amountCents / 100;
  const platformAmount = Number.parseFloat((totalDollars * (platformFeePercent / 100)).toFixed(2));
  const creatorAmount = Number.parseFloat((totalDollars - platformAmount).toFixed(2));

  return {
    chain: [
      { did: recipientDid, role: 'creator', amount: creatorAmount },
      { did: platformDid, role: 'platform', amount: platformAmount },
    ],
  };
}
