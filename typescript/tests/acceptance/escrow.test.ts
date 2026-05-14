import { test } from "bun:test";
import {
  makeEscrowContext,
  getDkgPublicKey,
  MultiSig,
  type DkgParticipateResult,
  type DkgVerifyInvalidResult,
  type DkgVerifyValidResult,
} from "../../dist/api";

test("3-of-5 escrow DKG group key", async () => {
  // generate 5 DKG keypairs: 2 for customer, 2 for merchant, 1 for arbitrator
  const count = 5;
  const threshold = 3;
  // setup customer keypairs
  const customer_sk1 = crypto.getRandomValues(new Uint8Array(64));
  const customer_pk1 = await getDkgPublicKey(customer_sk1);
  console.log("customer_pk1", customer_pk1);

  const customer_sk2 = crypto.getRandomValues(new Uint8Array(64));
  const customer_pk2 = await getDkgPublicKey(customer_sk2);
  console.log("customer_pk2", customer_pk2);

  // setup merchant keypairs
  const merchant_sk1 = crypto.getRandomValues(new Uint8Array(64));
  const merchant_pk1 = await getDkgPublicKey(merchant_sk1);
  console.log("merchant_pk1", merchant_pk1);

  const merchant_sk2 = crypto.getRandomValues(new Uint8Array(64));
  const merchant_pk2 = await getDkgPublicKey(merchant_sk2);
  console.log("merchant_pk2", merchant_pk2);

  // setup arbitrator keypair
  const arbitrator_sk = crypto.getRandomValues(new Uint8Array(64));
  const arbitrator_pk = await getDkgPublicKey(arbitrator_sk);
  console.log("arbitrator_pk", arbitrator_pk);
  const all_pk = [
    customer_pk1,
    customer_pk2,
    merchant_pk1,
    merchant_pk2,
    arbitrator_pk,
  ];

  const [
    customer_dkg1,
    customer_dkg2,
    merchant_dkg1,
    merchant_dkg2,
    arbitrator_dkg,
  ] = await Promise.all([
    MultiSig.createAndSetupGenerators(threshold, count),
    MultiSig.createAndSetupGenerators(threshold, count),
    MultiSig.createAndSetupGenerators(threshold, count),
    MultiSig.createAndSetupGenerators(threshold, count),
    MultiSig.createAndSetupGenerators(threshold, count),
  ]);
  console.log("finished setting up DKGs");
  const context = makeEscrowContext(0)["context"];
  if (!context) {
    throw new Error("context creation failed");
  }
  // customer and merchant run DKG participate
  const [customer_part1, customer_part2, merchant_part1] = await Promise.all([
    customer_dkg1.participate({
      dkg_secret_key: customer_sk1.toHex(),
      context,
      dkg_public_keys: all_pk,
      t: threshold,
    }),
    customer_dkg2.participate({
      dkg_secret_key: customer_sk2.toHex(),
      context,
      dkg_public_keys: all_pk,
      t: threshold,
    }),
    merchant_dkg1.participate({
      dkg_secret_key: merchant_sk1.toHex(),
      context,
      dkg_public_keys: all_pk,
      t: threshold,
    }),
  ]);
  const participations: Record<string, string> = {};
  if ("message" in customer_part1) {
    throw new Error(
      `participate failed for customer 1: ${customer_part1.message}`,
    );
  }
  participations["0"] = customer_part1.participation;
  if ("message" in customer_part2) {
    throw new Error(
      `participate failed for customer 2: ${customer_part2.message}`,
    );
  }
  participations["1"] = customer_part2.participation;
  if ("message" in merchant_part1) {
    throw new Error(
      `participate failed for merchant 1: ${merchant_part1.message}`,
    );
  }
  participations["2"] = merchant_part1.participation;

  console.log("participations finished:", participations);

  // verify with participant 0 key (any of them works)
  const verifyResult = (await customer_dkg1.verify({
    dkg_secret_key: customer_sk1.toHex(),
    context,
    t: threshold,
    dkg_public_keys: all_pk,
    participations,
  })) as DkgVerifyValidResult;

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
}, 120000);
