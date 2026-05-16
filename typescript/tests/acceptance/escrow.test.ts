import { expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";

import {
  makeEscrowContext,
  getDkgPublicKey,
  MultiSig,
  type DkgVerifyInvalidResult,
  type DkgVerifyValidResult,
  deriveEscrowViewpairCommsSecret,
  escrowViewPairECDHgetPublicKey,
  performEscrowViewPairECDH,
  getDkgMoneroAddress,
  makeTestKeyPair,
  type ScanSettings,
  writeScanSettings,
  openWallets,
  writeWalletToScanSettings,
  atomicWrite,
} from "../../dist/api";
const MONERONODE_DIR = "tests/moneronode";
const TEST_DATA_DIR = "test-data/escrow";
const ESCROW_DIR = TEST_DATA_DIR;
const MONEROD_PATH = `${MONERONODE_DIR}/monerod`;
const KEYPAIRS_PATH = `${MONERONODE_DIR}/keypairs.json`;
const SCAN_SETTINGS_PATH = `${ESCROW_DIR}/ScanSettings.json`;
const RPC_PORT = 18081;
const NODE_URL = `http://127.0.0.1:${RPC_PORT}`;
async function generateBlocks(address: string, count: number): Promise<void> {
  const resp = await fetch(`${NODE_URL}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "0",
      method: "generateblocks",
      params: { amount_of_blocks: count, wallet_address: address },
    }),
  });
  if (!resp.ok)
    throw new Error(`generateblocks RPC failed: ${resp.statusText}`);
  const result = await resp.json();
  if (result.error)
    throw new Error(`generateblocks error: ${JSON.stringify(result.error)}`);
}
async function waitForNode(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${NODE_URL}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.result?.height !== undefined) return;
      }
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("Node did not become ready within timeout");
}

async function startNode(): Promise<Bun.Subprocess> {
  return Bun.spawn(
    [
      MONEROD_PATH,
      "--regtest",
      "--offline",
      "--fixed-difficulty",
      "1",
      "--rpc-bind-ip",
      "127.0.0.1",
      "--rpc-bind-port",
      String(RPC_PORT),
      "--non-interactive",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
}
async function killLeftoverMonerod(): Promise<void> {
  await Bun.$`pgrep monerod && kill -9 $(pgrep monerod) 2>/dev/null; echo "monerod processes remaining: $(pgrep monerod | wc -l)"`;
}

async function startNodeIfNotRunning(): Promise<void> {
  const count = parseInt(
    (await Bun.$`pgrep monerod | wc -l`.quiet()).text().trim(),
  );
  console.log(`monerod processes running: ${count}`);
  if (count > 0) return;
  await startNode();
  await waitForNode();
}

async function cleanupEscrowDir(): Promise<void> {
  await rm(ESCROW_DIR, { force: true, recursive: true }).catch(() => {});
  await mkdir(ESCROW_DIR, { recursive: true });
}
const TX_BLOCKS = 10;
const TOTAL_BLOCKS = 1000;
async function TestASetup() {
  await cleanupEscrowDir();
  await killLeftoverMonerod();
  await startNode();
  await waitForNode();
  const customerKP = await makeTestKeyPair();
  const customerAddress = customerKP.view_key.mainnet_primary;
  Bun.env[`sk${customerAddress}`] = customerKP.spend_key;
  Bun.env[`vk${customerAddress}`] = customerKP.view_key.view_key;

  const scanSettings: ScanSettings = {
    wallets: [
      {
        primary_address: customerAddress,
      },
    ],
    node_url: NODE_URL,
    start_height: TOTAL_BLOCKS - 70,
  };
  await writeScanSettings(scanSettings, SCAN_SETTINGS_PATH);
  await generateBlocks(customerAddress, TOTAL_BLOCKS);
  let resolveSynced: () => void;
  const syncedPromise = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  let resolvePostTxSync: () => void;
  const postTxSyncPromise = new Promise<void>((resolve) => {
    resolvePostTxSync = resolve;
  });

  const wallets = await openWallets({
    scan_settings_path: SCAN_SETTINGS_PATH,
    pathPrefix: `${ESCROW_DIR}/`,
    no_stats: true,
    notifyMasterChanged: async (params) => {
      const last = params.newCache.scanned_ranges.at(-1);
      if (last && last.end >= TOTAL_BLOCKS) {
        resolveSynced();
      }
      if (last && last.end >= TOTAL_BLOCKS + TX_BLOCKS) {
        resolvePostTxSync();
      }
    },
  });
  await syncedPromise;
  return { wallets, postTxSyncPromise };
}

test("a: 3-of-5 escrow DKG group key, customer wallet spends tx into the escrow wallet", async () => {
  const customerWalletSynced = TestASetup();

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

  // simulate the bip39 getWalletSecret() return of 64 bytes of key data
  const customer_seed_derived_view_pair_sk = crypto.getRandomValues(
    new Uint8Array(64),
  );
  const customer_vp_sk = await deriveEscrowViewpairCommsSecret(
    customer_seed_derived_view_pair_sk,
  );
  const customer_vp_pk = await escrowViewPairECDHgetPublicKey(customer_vp_sk);

  // setup merchant keypairs
  const merchant_sk1 = crypto.getRandomValues(new Uint8Array(64));
  const merchant_pk1 = await getDkgPublicKey(merchant_sk1);
  console.log("merchant_pk1", merchant_pk1);

  const merchant_sk2 = crypto.getRandomValues(new Uint8Array(64));
  const merchant_pk2 = await getDkgPublicKey(merchant_sk2);
  console.log("merchant_pk2", merchant_pk2);
  // simulate the bip39 getWalletSecret() return of 64 bytes of key data
  const merchant_seed_derived_view_pair_sk = crypto.getRandomValues(
    new Uint8Array(64),
  );
  const merchant_vp_sk = await deriveEscrowViewpairCommsSecret(
    merchant_seed_derived_view_pair_sk,
  );
  const merchant_vp_pk = await escrowViewPairECDHgetPublicKey(merchant_vp_sk);

  // perform escrow viewpair ECDH
  const customer_escrow_viewpair_sk = await performEscrowViewPairECDH(
    customer_vp_sk,
    merchant_vp_pk,
  );
  const merchant_escrow_viewpair_sk = await performEscrowViewPairECDH(
    merchant_vp_sk,
    customer_vp_pk,
  );

  console.log("customer_escrow_viewpair_sk", customer_escrow_viewpair_sk);
  console.log("merchant_escrow_viewpair_sk", merchant_escrow_viewpair_sk);

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
  const [customer_part1, customer_part2, merchant_part1, customer_sync] =
    await Promise.all([
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
      customerWalletSynced,
    ]);
  const participations: Record<string, string> = {};
  if ("message" in customer_part1) {
    throw new Error(
      `participate failed for customer 1: ${customer_part1.message}`,
    );
  }
  participations["1"] = customer_part1.participation;
  if ("message" in customer_part2) {
    throw new Error(
      `participate failed for customer 2: ${customer_part2.message}`,
    );
  }
  participations["2"] = customer_part2.participation;
  if ("message" in merchant_part1) {
    throw new Error(
      `participate failed for merchant 1: ${merchant_part1.message}`,
    );
  }
  participations["3"] = merchant_part1.participation;

  console.log("participations finished:", participations);

  const verifyResultCustomer1 = (await customer_dkg1.verify({
    dkg_secret_key: customer_sk1.toHex(),
    context,
    t: threshold,
    dkg_public_keys: all_pk,
    participations,
  })) as DkgVerifyValidResult;
  const verifyResultCustomer2 = (await customer_dkg2.verify({
    dkg_secret_key: customer_sk2.toHex(),
    context,
    t: threshold,
    dkg_public_keys: all_pk,
    participations,
  })) as DkgVerifyValidResult;
  const verifyResultMerchant1 = (await merchant_dkg1.verify({
    dkg_secret_key: merchant_sk1.toHex(),
    context,
    t: threshold,
    dkg_public_keys: all_pk,
    participations,
  })) as DkgVerifyValidResult;
  const verifyResultMerchant2 = (await merchant_dkg2.verify({
    dkg_secret_key: merchant_sk2.toHex(),
    context,
    t: threshold,
    dkg_public_keys: all_pk,
    participations,
  })) as DkgVerifyValidResult;
  const verifyResultArbitrator = (await arbitrator_dkg.verify({
    dkg_secret_key: arbitrator_sk.toHex(),
    context,
    t: threshold,
    dkg_public_keys: all_pk,
    participations,
  })) as DkgVerifyValidResult;
  atomicWrite(
    ESCROW_DIR + "/verifyResult.json",
    JSON.stringify(
      {
        verifyResultCustomer1,
        verifyResultCustomer2,
        verifyResultMerchant1,
        verifyResultMerchant2,
        verifyResultArbitrator,
      },
      null,
      2,
    ),
  );
  const verifyResult = verifyResultCustomer1;
  const escrow_address = await getDkgMoneroAddress(
    verifyResult.group_key,
    customer_escrow_viewpair_sk,
  );

  console.log("escrow_address", escrow_address);

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
  if (!customer_sync.wallets) throw new Error("customer wallets not opened");
  const customerWallet = customer_sync.wallets.wallets[0];
  customer_sync.wallets.stopWorker();
  Bun.env[`vk${escrow_address.mainnet_primary}`] = merchant_escrow_viewpair_sk;
  await writeWalletToScanSettings({
    primary_address: escrow_address.mainnet_primary,
    start_height: 1000,
    scan_settings_path: SCAN_SETTINGS_PATH,
  });
  customer_sync.wallets.retry();
  // enable decoy retry (safe because we're on a local regtest node)

  customerWallet.decoyRetry = true;

  let unsignedTx: string;
  try {
    unsignedTx = await customerWallet.makeStandardTransaction(
      escrow_address.mainnet_primary,
      "133700000000",
    );
  } catch (e) {
    throw new Error(
      `transaction construction failed (likely not enough decoys): ${e}`,
    );
  }
  const signedTx = await customerWallet.signTransaction(unsignedTx);
  const sendResult = await customerWallet.sendTransaction(signedTx);
  expect(sendResult.status).toBe("OK");
  expect(sendResult.low_mixin).toBe(false);
  expect(sendResult.double_spend).toBe(false);
  expect(sendResult.fee_too_low).toBe(false);
  expect(sendResult.invalid_input).toBe(false);
  expect(sendResult.invalid_output).toBe(false);
  expect(sendResult.not_relayed).toBe(false);
  expect(sendResult.overspend).toBe(false);
  expect(sendResult.too_big).toBe(false);

  await generateBlocks(customerWallet.primary_address, TX_BLOCKS);
  await customer_sync.postTxSyncPromise;
}, 120000);

test("b: 7 days have passed, merchant sends escrow tx, signs together with arbitrator", async () => {
  console.log();
  const wallets = await openWallets({ scan_settings_path: SCAN_SETTINGS_PATH });
  // wallets?.wallets.find(
  //   (w) => w.primary_address === escrow_address.mainnet_primary,
  // );
}, 120000);
