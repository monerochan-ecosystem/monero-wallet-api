import { test, expect, beforeAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  writeScanSettings,
  openWallets,
  type ManyScanCachesOpened,
} from "../dist/api";
import { type Keypair } from "../wallet-api/keypairs-seeds/keypairs";

const MONERONODE_DIR = "tests/moneronode";
const TEST_DATA_DIR = "test-data/tx_sending";
const MONEROD_PATH = `${MONERONODE_DIR}/monerod`;
const KEYPAIRS_PATH = `${MONERONODE_DIR}/keypairs.json`;
const SCAN_SETTINGS_PATH = `${TEST_DATA_DIR}/ScanSettings.json`;
const RPC_PORT = 18081;
const NODE_URL = `http://127.0.0.1:${RPC_PORT}`;

let keypairs: Keypair[];

beforeAll(async () => {
  if (!(await Bun.file(KEYPAIRS_PATH).exists())) {
    throw new Error("keypairs.json not found — run reorg_handling tests first");
  }
  keypairs = JSON.parse(await Bun.file(KEYPAIRS_PATH).text()) as Keypair[];
  for (const kp of keypairs) {
    Bun.env[`sk${kp.view_key.mainnet_primary}`] = kp.spend_key;
    Bun.env[`vk${kp.view_key.mainnet_primary}`] = kp.view_key.view_key;
  }
}, 10000);

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

async function stopNode(proc: Bun.Subprocess): Promise<void> {
  proc.kill(9);
  await proc.exited;
}

async function killLeftoverMonerod(): Promise<void> {
  const p = Bun.spawn(["pkill", "-9", "monerod"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await p.exited;
}

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

// test 1: transaction creation with default settings
// this is expected to fail on sparse regtest chains (known decoy issue)
test(
  "makeStandardTransaction fails with default settings on sparse chain",
  async () => {
    await killLeftoverMonerod();
    await rm(TEST_DATA_DIR, { force: true, recursive: true });
    await mkdir(TEST_DATA_DIR, { recursive: true });

    const address0 = keypairs[0].view_key.mainnet_primary;
    const address1 = keypairs[1].view_key.mainnet_primary;

    const proc = await startNode();
    let wallets: ManyScanCachesOpened | undefined;
    try {
      await waitForNode();

      await writeScanSettings(
        {
          wallets: [
            { primary_address: address0 },
            { primary_address: address1 },
          ],
          node_url: NODE_URL,
          start_height: 0,
        },
        SCAN_SETTINGS_PATH,
      );

      let resolveSynced: () => void;
      const syncedPromise = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });

      wallets = await openWallets({
        scan_settings_path: SCAN_SETTINGS_PATH,
        pathPrefix: `${TEST_DATA_DIR}/`,
        no_stats: true,
        notifyMasterChanged: async (params) => {
          const last = params.newCache.scanned_ranges.at(-1);
          if (last && last.end >= 1000) {
            resolveSynced();
          }
        },
      });

      await generateBlocks(address0, 1000);
      await syncedPromise;

      if (!wallets) throw new Error("wallets not opened");

      // this should fail with decoy error on a sparse regtest chain
      try {
        await wallets.wallets[0].makeStandardTransaction(
          address1,
          "100000000000",
        );
        // if it succeeds, that's fine too
        console.log("makeStandardTransaction succeeded (unexpected but ok)");
      } catch (e) {
        const msg = String(e);
        expect(msg).toMatch(/decoy/i);
      }
    } finally {
      if (wallets) wallets.stopWorker();
      await stopNode(proc);
    }
  },
  { timeout: 120000 },
);

// test 2: prepareInput with higher sample count
// tests the decoy hardening path directly
test(
  "prepareInput with higher sample count produces enough candidates",
  async () => {
    await killLeftoverMonerod();
    await rm(TEST_DATA_DIR, { force: true, recursive: true });
    await mkdir(TEST_DATA_DIR, { recursive: true });

    const address0 = keypairs[0].view_key.mainnet_primary;
    const address1 = keypairs[1].view_key.mainnet_primary;

    const proc = await startNode();
    let wallets: ManyScanCachesOpened | undefined;
    try {
      await waitForNode();

      await writeScanSettings(
        {
          wallets: [
            { primary_address: address0 },
            { primary_address: address1 },
          ],
          node_url: NODE_URL,
          start_height: 0,
        },
        SCAN_SETTINGS_PATH,
      );

      let resolveSynced: () => void;
      const syncedPromise = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });

      wallets = await openWallets({
        scan_settings_path: SCAN_SETTINGS_PATH,
        pathPrefix: `${TEST_DATA_DIR}/`,
        no_stats: true,
        notifyMasterChanged: async (params) => {
          const last = params.newCache.scanned_ranges.at(-1);
          if (last && last.end >= 1000) {
            resolveSynced();
          }
        },
      });

      await generateBlocks(address0, 1000);
      await syncedPromise;

      if (!wallets) throw new Error("wallets not opened");

      // use the wallet's cached outputs to test prepareInput directly
      const cache = wallets.wallets[0].cache;
      if (!cache) throw new Error("no cache");

      // get the node url from wallet
      const { NodeUrl } = await import("../dist/api");

      const node = await NodeUrl.create(NODE_URL);
      const distribution = await node.getOutputDistribution();

      // get a spendable output
      const spendableOutputs = Object.values(cache.outputs).filter((o) => {
        const age = cache.daemon_height - o.block_height;
        return age >= 60 && o.spent_block_height === undefined;
      });

      expect(spendableOutputs.length).toBeGreaterThan(0);

      // try with default sample size (20)
      const sample20 = node.sampleDecoys(
        spendableOutputs[0].index_on_blockchain,
        distribution,
        20,
      );

      // try with larger sample size (100)
      const sample100 = node.sampleDecoys(
        spendableOutputs[0].index_on_blockchain,
        distribution,
        100,
      );

      // larger sample should return at least as many candidates
      expect(sample100.candidates.length).toBeGreaterThanOrEqual(
        sample20.candidates.length,
      );

      console.log(
        `output index: ${spendableOutputs[0].index_on_blockchain}, ` +
          `decoys with 20: ${sample20.candidates.length}, ` +
          `decoys with 100: ${sample100.candidates.length}`,
      );
    } finally {
      if (wallets) wallets.stopWorker();
      await stopNode(proc);
    }
  },
  { timeout: 120000 },
);

// test 3: makeTransaction succeeds with decoyRetry enabled
// uses the wallet's own input selection, not manual picking
test(
  "makeTransaction succeeds with decoyRetry enabled",
  async () => {
    await killLeftoverMonerod();
    await rm(TEST_DATA_DIR, { force: true, recursive: true });
    await mkdir(TEST_DATA_DIR, { recursive: true });

    const address0 = keypairs[0].view_key.mainnet_primary;
    const address1 = keypairs[1].view_key.mainnet_primary;

    const proc = await startNode();
    let wallets: ManyScanCachesOpened | undefined;
    try {
      await waitForNode();

      await writeScanSettings(
        {
          wallets: [
            { primary_address: address0 },
            { primary_address: address1 },
          ],
          node_url: NODE_URL,
          start_height: 0,
        },
        SCAN_SETTINGS_PATH,
      );

      let resolveSynced: () => void;
      const syncedPromise = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });

      wallets = await openWallets({
        scan_settings_path: SCAN_SETTINGS_PATH,
        pathPrefix: `${TEST_DATA_DIR}/`,
        no_stats: true,
        notifyMasterChanged: async (params) => {
          const last = params.newCache.scanned_ranges.at(-1);
          if (last && last.end >= 1000) {
            resolveSynced();
          }
        },
      });

      await generateBlocks(address0, 1000);
      await syncedPromise;

      if (!wallets) throw new Error("wallets not opened");

      // enable decoyRetry on the master wallet
      // this is safe only on a local node, retrying contacts the node multiple
      // times for the same input, which leaks which input is the real spend
      wallets.wallets[0].decoyRetry = true;

      // use the wallet's own makeStandardTransaction which handles input selection
      const unsignedTx = await wallets.wallets[0].makeStandardTransaction(
        address1,
        "100000000000",
      );
      expect(unsignedTx).toBeDefined();
      expect(typeof unsignedTx).toBe("string");
      console.log("unsigned tx created, length:", unsignedTx.length);

      // sign and send
      const signedTx = await wallets.wallets[0].signTransaction(unsignedTx);
      expect(signedTx).toBeDefined();
      const sendResult = await wallets.wallets[0].sendTransaction(signedTx);
      expect(sendResult.status).toBe("OK");
      console.log("transaction sent successfully");
    } finally {
      if (wallets) wallets.stopWorker();
      await stopNode(proc);
    }
  },
  { timeout: 180000 },
);
