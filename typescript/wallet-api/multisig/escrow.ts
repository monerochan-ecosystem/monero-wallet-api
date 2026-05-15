import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { numberToBytesLE } from "@noble/curves/utils.js";
import { blake3 } from "@noble/hashes/blake3.js";

export function makeEscrowContext(context_index: number) {
  if (Number.isNaN(parseInt(String(context_index)))) {
    return { ok: false, error: `invalid context_index: "${context_index}"` };
  }
  if (parseInt(String(context_index)) < 0) {
    return {
      ok: false,
      error: `invalid context_index: "${context_index} < 0"`,
    };
  }
  if (parseInt(String(context_index)) > 10000) {
    return {
      ok: false,
      error: `invalid context_index: "${context_index} > 10000"`,
    };
  }
  const context = "escrow-" + String(context_index);
  return { ok: true, context, context_index };
}
export function parseEscrowContext(input: string) {
  const parts = input.split("-");
  if (parts.length < 1 || !parts[0] || parts[0] !== "escrow") {
    return {
      ok: false,
      error: "missing escrow string before - ${context_index}",
    };
  }
  const context_index = parts[1];
  if (Number.isNaN(parseInt(String(context_index)))) {
    return { ok: false, error: `invalid context_index: "${context_index}"` };
  }
  if (parseInt(String(context_index)) < 0) {
    return {
      ok: false,
      error: `invalid context_index: "${context_index} < 0"`,
    };
  }
  if (parseInt(String(context_index)) > 10000) {
    return {
      ok: false,
      error: `invalid context_index: "${context_index} > 10000"`,
    };
  }
  const context = "escrow-" + String(context_index);
  return { ok: true, context, context_index };
}
/**
 * To give users the ability to conveniently partake in escrow transactions,
 * the necessary secrets need to be organized well.
 *
 * The seedphrase package in this repository provides methods to derive
 * secrets from a "walletroute" and a bip39 seedphrase.
 *
 * The "walletroute" is a string that is human readable and gives
 * information on the context the wallet is created for.
 *
 * getWalletSecret() in the seedphrase package returns:
 * 64 bytes of key data - uses KDF ( bip39.mnemonicToSeedSync of noble bip39)
 *
 * We use this method to derive the escrow-viewpair-comms secret from the
 * "comms" key type of a walletroute. (consult the seedphrase package readme for more information)
 *
 * @param bip39_secret : 64 bytes key data
 * @returns 32 bytes secret
 */
export function deriveEscrowViewpairCommsSecret(bip39_secret: Uint8Array) {
  if (bip39_secret.length !== 64) {
    throw new Error("expected exactly 64 bytes for Multisig secret viewkey");
  }
  const txt = new TextEncoder();
  return blake3(bip39_secret, { context: txt.encode("escrow-viewpair-comms") });
}

export function escrowViewPairECDHgetPublicKey(vp_comms_secret: Uint8Array) {
  return ed25519.getPublicKey(vp_comms_secret);
}
/**
 * In the typical escrow setup, from the perspective of the customer,
 * the customer_sk is used together with the merchant pk to make the
 * escrow wallet viewpair.
 *
 * From the perspective of the merchant,
 *  the merchant_sk is used together with the customer pk to make the
 * escrow wallet viewpair.
 *
 * In the dispute flow case, the disputer shares the shared secret,
 * that resulted from this ECDH exchange with the arbitrator.
 * @param alice_sk - your viewpair secret
 * @param bob_pk - the other multisig (escrow) party's viewpair public key
 */
export function performEscrowViewPairECDH(
  alice_sk: Uint8Array,
  bob_pk: Uint8Array,
) {
  const txt = new TextEncoder();

  const aliceSecX = ed25519.utils.toMontgomerySecret(alice_sk);
  const bobPubX = ed25519.utils.toMontgomery(bob_pk);
  const sharedKey = x25519.getSharedSecret(aliceSecX, bobPubX);
  const sharedSecret = blake3(sharedKey, {
    context: txt.encode("escrow-viewpair-comms"),
  });

  const scalar = numberToBytesLE(
    ed25519.Point.Fn.fromBytes(sharedSecret),
    32,
  ).toHex();
  return scalar;
}
