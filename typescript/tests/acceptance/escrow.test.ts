import { test } from "bun:test";
import {
  DistributedKeyGenerator,
  type DkgParticipateResult,
  type DkgVerifyInvalidResult,
  type DkgVerifyValidResult,
} from "../../dist/api";

test("3-of-5 escrow DKG group key", async () => {
  // generate 5 DKG keypairs: 2 for customer, 2 for merchant, 1 for arbitrator
  const count = 5;
  const threshold = 3;
  const secretKeys: Uint8Array[] = [];
  const publicKeys: string[] = [];

  const dkg = await DistributedKeyGenerator.create(threshold, count);

  for (let i = 0; i < count; i++) {
    const sk = crypto.getRandomValues(new Uint8Array(64));
    secretKeys.push(sk);
    const pubResult = dkg.getPublicKey(sk);
    if ("message" in pubResult) {
      throw new Error(
        `getPublicKey failed for participant ${i}: ${pubResult.message}`,
      );
    }
    publicKeys.push(pubResult.dkg_public_key);
    console.log(`  participant ${i} dkg_public_key:`, pubResult.dkg_public_key);
  }

  // 32-byte random context
  const context = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex");

  // all 5 participants run DKG participate
  const participations: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const partResult = dkg.participate({
      dkg_secret_key: Buffer.from(secretKeys[i]).toString("hex"),
      context,
      dkg_public_keys: publicKeys,
      t: threshold,
    }) as DkgParticipateResult;
    if ("message" in partResult) {
      throw new Error(
        `participate failed for participant ${i}: ${(partResult as any).message}`,
      );
    }
    console.log(`  participant ${i} participation:`, partResult.participation);
    participations[(i + 1).toString()] = partResult.participation;
  }

  // verify with participant 0 key (any of them works)
  const verifyResult = dkg.verify({
    dkg_secret_key: Buffer.from(secretKeys[0]).toString("hex"),
    context,
    t: threshold,
    dkg_public_keys: publicKeys,
    participations,
  }) as DkgVerifyValidResult;

  if ("group_key" in verifyResult) {
    console.log("\n  3-of-5 group key:", verifyResult.group_key);
    console.log("  t:", verifyResult.t, "n:", verifyResult.n);
  } else if ("faulty_participants" in verifyResult) {
    console.error(
      "faulty:",
      (verifyResult as DkgVerifyInvalidResult).faulty_participants,
    );
  } else {
    console.error("message:", (verifyResult as any).message);
  }
});
