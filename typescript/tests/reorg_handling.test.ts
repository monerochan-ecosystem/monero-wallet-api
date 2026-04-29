import { test, expect, beforeAll } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import {
  writeScanSettings,
  openWallets,
  cacheFileDefaultLocation,
  readConnectionStatusDefaultLocation,
  blocksBufferFetchLoop,
  type ManyScanCachesOpened,
  type ScanCache,
  type ReorgInfo,
} from "../dist/api";
import {
  makeTestKeyPair,
  type Keypair,
} from "../wallet-api/keypairs-seeds/keypairs";
import type { ScanSettings } from "../wallet-api/scanning-syncing/scanSettings";

const MONERONODE_DIR = "tests/moneronode";
const TEST_DATA_DIR = "test-data/reorg_handling";
const REORG_DIR = TEST_DATA_DIR;
const MONEROD_PATH = `${MONERONODE_DIR}/monerod`;
const KEYPAIRS_PATH = `${MONERONODE_DIR}/keypairs.json`;
const SCAN_SETTINGS_PATH = `${REORG_DIR}/ScanSettings.json`;
const RPC_PORT = 18081;
const NODE_URL = `http://127.0.0.1:${RPC_PORT}`;

async function setupMoneroNode(): Promise<void> {
  if (await Bun.file(MONEROD_PATH).exists()) return;

  await mkdir(MONERONODE_DIR, { recursive: true });

  console.log("Downloading hashes.txt...");
  const hashesResp = await fetch("https://getmonero.org/downloads/hashes.txt");
  if (!hashesResp.ok)
    throw new Error(`Failed to download hashes.txt: ${hashesResp.statusText}`);
  const hashesText = await hashesResp.text();
  await Bun.write(`${MONERONODE_DIR}/hashes.txt`, hashesText);

  try {
    const gpgKeyResp = await fetch(
      "https://raw.githubusercontent.com/monero-project/monero/master/utils/gpg_keys/binaryfate.asc",
    );
    if (gpgKeyResp.ok) {
      await Bun.write(`${MONERONODE_DIR}/binaryfate.asc`, gpgKeyResp);
      const imp = Bun.spawn(
        ["gpg", "--import", `${MONERONODE_DIR}/binaryfate.asc`],
        { stdout: "pipe", stderr: "pipe" },
      );
      await imp.exited;
      const ver = Bun.spawn(
        ["gpg", "--verify", `${MONERONODE_DIR}/hashes.txt`],
        { stdout: "pipe", stderr: "pipe" },
      );
      await ver.exited;
    }
  } catch {
    console.warn("GPG verification unavailable, skipping");
  }

  console.log("Downloading monero CLI binaries...");
  const binResp = await fetch("https://downloads.getmonero.org/cli/linux64");
  if (!binResp.ok) throw new Error(`Download failed: ${binResp.statusText}`);

  const disposition = binResp.headers.get("content-disposition");
  const tarballName =
    disposition?.match(/filename="?(.+?)"?$/)?.[1] ??
    binResp.url.split("/").pop() ??
    "monero-linux.tar.bz2";
  const tarballPath = `${MONERONODE_DIR}/${tarballName}`;

  const contentLength = binResp.headers.get("content-length");
  const total = contentLength ? Number(contentLength) : 0;
  let downloaded = 0;
  let lastLog = 0;
  if (!binResp.body) throw new Error("download response has no body");
  const reader = binResp.body.getReader();
  const writer = Bun.file(tarballPath).writer();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    downloaded += value.length;
    writer.write(value);
    if (total && Date.now() - lastLog > 2000) {
      lastLog = Date.now();
      const pct = ((downloaded / total) * 100).toFixed(1);
      console.log(
        `  ${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB (${pct}%)`,
      );
    } else if (!total && Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      console.log(`  ${(downloaded / 1024 / 1024).toFixed(1)}MB downloaded`);
    }
  }
  writer.end();

  const tarballData = await Bun.file(tarballPath).arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", tarballData);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const hashLines = hashesText.split("\n").filter((l) => l.trim().length > 0);
  if (!hashLines.some((l) => l.startsWith(hashHex))) {
    await Bun.spawn(["rm", tarballPath]).exited;
    throw new Error(
      "sha256 verification failed, downloaded binary may be tampered or corrupted",
    );
  }

  console.log("SHA256 verification passed. Extracting...");
  const extractDir = `${MONERONODE_DIR}/extracted`;
  await mkdir(extractDir, { recursive: true });
  const tar = Bun.spawn(["tar", "-xf", tarballPath, "-C", extractDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await tar.exited) !== 0) {
    const err = await new Response(tar.stderr).text();
    throw new Error(`Extraction failed: ${err}`);
  }

  const entries = await readdir(extractDir);
  const subdir = entries.find((e) => e.startsWith("monero-"));
  if (!subdir)
    throw new Error("Unexpected tarball structure: no monero- directory found");
  await Bun.spawn(["mv", `${extractDir}/${subdir}/monerod`, MONEROD_PATH])
    .exited;

  await Bun.spawn(["rm", "-rf", extractDir]).exited;
  await Bun.spawn(["rm", tarballPath]).exited;
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

async function stopNode(proc: Bun.Subprocess): Promise<void> {
  proc.kill(9);
  await proc.exited;
}

async function setupKeypairFixtures(): Promise<void> {
  if (!(await Bun.file(KEYPAIRS_PATH).exists())) {
    const keypairs: Keypair[] = [];
    for (let i = 0; i < 10; i++) {
      console.log(`Generating keypair ${i + 1}/10...`);
      keypairs.push(await makeTestKeyPair());
    }
    await Bun.write(KEYPAIRS_PATH, JSON.stringify(keypairs, null, 2));
  }

  const keypairs = JSON.parse(
    await Bun.file(KEYPAIRS_PATH).text(),
  ) as Keypair[];
  for (const kp of keypairs) {
    Bun.env[`sk${kp.view_key.mainnet_primary}`] = kp.spend_key;
    Bun.env[`vk${kp.view_key.mainnet_primary}`] = kp.view_key.view_key;
  }

  const scanSettings: ScanSettings = {
    wallets: keypairs.map((kp) => ({
      primary_address: kp.view_key.mainnet_primary,
    })),
    node_url: NODE_URL,
    start_height: 0,
  };
  await writeScanSettings(scanSettings, SCAN_SETTINGS_PATH);
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

async function killLeftoverMonerod(): Promise<void> {
  const p = Bun.spawn(["pkill", "-9", "monerod"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await p.exited;
}

async function cleanupReorgDir(): Promise<void> {
  await rm(REORG_DIR, { force: true, recursive: true }).catch(() => {});
  await mkdir(REORG_DIR, { recursive: true });
}

beforeAll(
  async () => {
    await killLeftoverMonerod();
    await setupMoneroNode();
    await setupKeypairFixtures();
  },
  { timeout: 600000 },
);

// no afterAll cleanup,files stay on disk for debugging

// test(
//   "start monero regtest node and verify RPC responds",
//   async () => {
//     const proc = await startNode();
//     try {
//       await waitForNode();
//       const info = await get_info(NODE_URL);
//       expect(info.height).toBe(1);
//       expect(info.status).toBe("OK");
//     } finally {
//       await stopNode(proc);
//     }
//   },
//   { timeout: 60000 },
// );

// test(
//   "stop and restart monero regtest node",
//   async () => {
//     const proc1 = await startNode();
//     try {
//       await waitForNode();
//       const info1 = await get_info(NODE_URL);
//       expect(info1.height).toBe(1);
//       expect(info1.status).toBe("OK");
//     } finally {
//       await stopNode(proc1);
//     }

//     const proc2 = await startNode();
//     try {
//       await waitForNode();
//       const info2 = await get_info(NODE_URL);
//       expect(info2.height).toBe(1);
//       expect(info2.status).toBe("OK");
//     } finally {
//       await stopNode(proc2);
//     }
//   },
//   { timeout: 60000 },
// );

// test(
//   "mine 1000 blocks then restart with fresh chain",
//   async () => {
//     const keypairs = JSON.parse(
//       await Bun.file(KEYPAIRS_PATH).text(),
//     ) as Keypair[];
//     const address = keypairs[0].view_key.mainnet_primary;

//     const proc = await startNode();
//     try {
//       await waitForNode();
//       await generateBlocks(address, 1000);
//       const info = await get_info(NODE_URL);
//       expect(info.height).toBe(1001);
//       expect(info.status).toBe("OK");
//     } finally {
//       await stopNode(proc);
//     }
//     const proc2 = await startNode();
//     try {
//       await waitForNode();
//       const info2 = await get_info(NODE_URL);
//       expect(info2.height).toBe(1);
//       expect(info2.status).toBe("OK");
//     } finally {
//       await stopNode(proc2);
//     }
//   },
//   { timeout: 120000 },
// );

test(
  "pop blocks mid-session, cache stays intact with reorged outputs and reorg_info",
  async () => {
    await cleanupReorgDir();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text()) as Keypair[];
    const address = kp[0].view_key.mainnet_primary;

    const proc = await startNode();
    let wallets: ManyScanCachesOpened | undefined;
    try {
      await waitForNode();

      await writeScanSettings(
        {
          wallets: kp.map((k) => ({
            primary_address: k.view_key.mainnet_primary,
          })),
          node_url: NODE_URL,
          start_height: null,
        },
        SCAN_SETTINGS_PATH,
      );

      let resolveReorg: () => void;
      const reorgPromise = new Promise<void>((resolve) => {
        resolveReorg = resolve;
      });

      let resolveSynced: () => void;
      const syncedPromise = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });

      wallets = await openWallets({
        scan_settings_path: SCAN_SETTINGS_PATH,
        pathPrefix: `${REORG_DIR}/`,
        no_stats: true,
        notifyMasterChanged: async (params) => {
          if (params.newCache.reorg_info) {
            resolveReorg();
            return;
          }
          const last = params.newCache.scanned_ranges.at(-1);
          if (last && last.end >= 5) {
            resolveSynced();
          }
        },
      });

      await generateBlocks(address, 5);
      await syncedPromise;

      await fetch(`${NODE_URL}/pop_blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nblocks: 2 }),
      });
      await generateBlocks(kp[1].view_key.mainnet_primary, 3);

      await reorgPromise;

      const cachePath = cacheFileDefaultLocation(address, `${REORG_DIR}/`);
      const cacheJson = JSON.parse(
        await Bun.file(cachePath).text(),
      ) as ScanCache;
      expect(cacheJson.reorg_info).toBeDefined();
      if (!cacheJson.reorg_info) throw new Error("reorg_info missing");
      expect(cacheJson.reorg_info.split_height).toBeDefined();
      expect(typeof cacheJson.reorg_info.split_height.block_height).toBe(
        "number",
      );

      const connStatus =
        await readConnectionStatusDefaultLocation(SCAN_SETTINGS_PATH);
      expect(connStatus).toBeDefined();
      if (!connStatus) throw new Error("connection status missing");
      expect(connStatus.last_packet.status).toBe("OK");
    } finally {
      if (wallets) wallets.stopWorker();
      await stopNode(proc);
    }
  },
  { timeout: 120000 },
);

test(
  "reorg after tx between wallets shows removed outputs and reverted spends",
  async () => {
    await cleanupReorgDir();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text()) as Keypair[];
    const address0 = kp[0].view_key.mainnet_primary;
    const address1 = kp[1].view_key.mainnet_primary;

    const proc = await startNode();
    let wallets: ManyScanCachesOpened | undefined;
    try {
      await waitForNode();

      const TOTAL_BLOCKS = 1000;
      const TX_BLOCKS = 1;
      const POP_BLOCKS = 10;

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

      let syncedCalled = false;
      let resolveSynced: () => void;
      const syncedPromise = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });

      let resolvePostTxSync: () => void;
      const postTxSyncPromise = new Promise<void>((resolve) => {
        resolvePostTxSync = resolve;
      });

      let resolveReorg: () => void;
      const reorgPromise = new Promise<void>((resolve) => {
        resolveReorg = resolve;
      });
      let capturedReorgInfo: ReorgInfo | undefined;

      wallets = await openWallets({
        scan_settings_path: SCAN_SETTINGS_PATH,
        pathPrefix: `${REORG_DIR}/`,
        no_stats: true,
        notifyMasterChanged: async (params) => {
          const last = params.newCache.scanned_ranges.at(-1);
          if (last && last.end >= TOTAL_BLOCKS && !syncedCalled) {
            syncedCalled = true;
            resolveSynced();
          }
          if (last && last.end >= TOTAL_BLOCKS + TX_BLOCKS) {
            resolvePostTxSync();
          }
          if (params.newCache.reorg_info) {
            capturedReorgInfo =
              capturedReorgInfo || structuredClone(params.newCache.reorg_info);
            resolveReorg();
          }
        },
      });

      await generateBlocks(address0, TOTAL_BLOCKS);
      await syncedPromise;

      if (!wallets) throw new Error("wallets not opened");

      // enable decoy retry (safe because we're on a local regtest node)
      wallets.wallets[0].decoyRetry = true;

      let unsignedTx: string;
      try {
        unsignedTx = await wallets.wallets[0].makeStandardTransaction(
          address1,
          "100000000000",
        );
      } catch (e) {
        throw new Error(
          `transaction construction failed (likely not enough decoys): ${e}`,
        );
      }
      const signedTx = await wallets.wallets[0].signTransaction(unsignedTx);
      const sendResult = await wallets.wallets[0].sendTransaction(signedTx);
      expect(sendResult.status).toBe("OK");
      expect(sendResult.low_mixin).toBe(false);
      expect(sendResult.double_spend).toBe(false);
      expect(sendResult.fee_too_low).toBe(false);
      expect(sendResult.invalid_input).toBe(false);
      expect(sendResult.invalid_output).toBe(false);
      expect(sendResult.not_relayed).toBe(false);
      expect(sendResult.overspend).toBe(false);
      expect(sendResult.too_big).toBe(false);

      await generateBlocks(address0, TX_BLOCKS);
      await postTxSyncPromise;

      await fetch(`${NODE_URL}/pop_blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nblocks: POP_BLOCKS }),
      });
      await fetch(`${NODE_URL}/flush_txpool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      await generateBlocks(address1, POP_BLOCKS);

      await reorgPromise;

      if (!capturedReorgInfo) throw new Error("reorg was not detected");
      expect(capturedReorgInfo.reverted_spends.length).toBeGreaterThan(0);

      // wait for slave wallet to be fed and cache written
      let cache1: ScanCache | undefined;
      for (let i = 0; i < 50; i++) {
        cache1 = JSON.parse(
          await Bun.file(
            cacheFileDefaultLocation(address1, `${REORG_DIR}/`),
          ).text(),
        ) as ScanCache;
        if (cache1.reorg_info) break;
        await Bun.sleep(100);
      }
      if (!cache1) throw new Error("slave cache was not written");
      if (!cache1.reorg_info)
        throw new Error("reorg_info missing on slave cache");
      expect(cache1.reorg_info.removed_outputs.length).toBeGreaterThan(0);

      const connStatus =
        await readConnectionStatusDefaultLocation(SCAN_SETTINGS_PATH);
      expect(connStatus).toBeDefined();
      if (!connStatus) throw new Error("connection status missing");
      expect(connStatus.last_packet.status).toBe("OK");
    } finally {
      if (wallets) wallets.stopWorker();
      await stopNode(proc);
    }
  },
  { timeout: 60000 },
);

test(
  "reorg after restarting with a fresh chain shows catastrophic_reorg",
  async () => {
    await cleanupReorgDir();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text()) as Keypair[];
    const address = kp[0].view_key.mainnet_primary;

    const proc1 = await startNode();
    let wallets1: ManyScanCachesOpened | undefined;
    try {
      await waitForNode();

      await writeScanSettings(
        {
          wallets: kp.map((k) => ({
            primary_address: k.view_key.mainnet_primary,
          })),
          node_url: NODE_URL,
          start_height: null,
        },
        SCAN_SETTINGS_PATH,
      );

      let resolveSynced: () => void;
      const syncedPromise = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });

      wallets1 = await openWallets({
        scan_settings_path: SCAN_SETTINGS_PATH,
        pathPrefix: `${REORG_DIR}/`,
        no_stats: true,
        notifyMasterChanged: async (params) => {
          const last = params.newCache.scanned_ranges.at(-1);
          if (last && last.end >= 5) {
            resolveSynced();
          }
        },
      });

      await generateBlocks(address, 5);
      await syncedPromise;
    } finally {
      if (wallets1) wallets1.stopWorker();
      await stopNode(proc1);
    }

    const proc2 = await startNode();
    let wallets2: ManyScanCachesOpened | undefined;
    try {
      await waitForNode();
      await generateBlocks(address, 5);

      let resolveError: () => void;
      const errorPromise = new Promise<void>((resolve) => {
        resolveError = resolve;
      });

      wallets2 = await openWallets({
        scan_settings_path: SCAN_SETTINGS_PATH,
        pathPrefix: `${REORG_DIR}/`,
        no_stats: true,
        workerError: () => {
          resolveError();
        },
      });

      await errorPromise;

      const connStatus =
        await readConnectionStatusDefaultLocation(SCAN_SETTINGS_PATH);
      expect(connStatus?.last_packet.status).toBe("catastrophic_reorg");
    } finally {
      if (wallets2) wallets2.stopWorker();
      await stopNode(proc2);
    }
  },
  { timeout: 120000 },
);

test(
  "blocksBufferFetchLoop calls notifyHandler for each fetched item",
  async () => {
    await killLeftoverMonerod();
    await cleanupReorgDir();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text()) as Keypair[];
    const address = kp[0].view_key.mainnet_primary;
    const scan_settings_path = `${REORG_DIR}/buffer-notify.json`;

    const proc = await startNode();
    try {
      await waitForNode();

      const notified: any[] = [];
      const notifyHandler = (item: any) => {
        notified.push(item?.end ?? null);
      };

      const controller = new AbortController();
      // blocksBufferFetchLoop runs forever — start it, don't await
      const loopPromise = blocksBufferFetchLoop(
        NODE_URL,
        0,
        scan_settings_path,
        controller.signal,
        notifyHandler,
      );

      // let it initialise, then generate blocks so the loop catches them
      await Bun.sleep(1000);
      await generateBlocks(address, 5);
      await Bun.sleep(3000);
      controller.abort();
      await loopPromise;

      // notifyHandler must have been called with at least one item
      expect(notified.length).toBeGreaterThan(0);
      // at least one item should have a block end height (not null/undefined from tip)
      expect(notified.some((n) => typeof n === "number")).toBe(true);
    } finally {
      await stopNode(proc);
    }
  },
  { timeout: 60000 },
);

test(
  "blocksBufferFetchLoop handles normal reorg, trims buffer front and refetches",
  async () => {
    await killLeftoverMonerod();
    await cleanupReorgDir();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text()) as Keypair[];
    const address = kp[0].view_key.mainnet_primary;
    const scan_settings_path = `${REORG_DIR}/buffer-normal-reorg.json`;

    const proc = await startNode();
    try {
      await waitForNode();

      const controller = new AbortController();
      const items: any[] = [];
      const loopPromise = blocksBufferFetchLoop(
        NODE_URL,
        0,
        scan_settings_path,
        controller.signal,
        (item) => {
          if (item) items.push(item);
        },
      );

      // let it initialise (cullTooLargeScanHeight sets start_height to latest block)
      await Bun.sleep(1000);

      // now generate blocks — the fetch loop will pick them up
      await generateBlocks(address, 20);
      await Bun.sleep(3000);

      // pop blocks to cause a reorg
      await fetch(`${NODE_URL}/pop_blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nblocks: 2 }),
      });
      await generateBlocks(address, 5);
      await Bun.sleep(3000);

      controller.abort();
      await loopPromise;

      const connStatus =
        await readConnectionStatusDefaultLocation(scan_settings_path);
      expect(connStatus).toBeDefined();
      if (!connStatus) throw new Error("connection status missing");

      expect(connStatus.last_packet.status).toBe("OK");
      expect(connStatus.sync.scanned_ranges.length).toBeGreaterThan(0);
      expect(connStatus.sync.current_range).toBeDefined();
      const lastRange = connStatus.sync.scanned_ranges.at(-1);
      expect(lastRange).toBeDefined();
      expect(typeof lastRange!.end).toBe("number");

      expect(connStatus.sync.reorg_split_height).toBeDefined();

      // verify reorg_infos has an entry
      expect(connStatus.sync.reorg_infos.length).toBeGreaterThan(0);
      expect(connStatus.sync.reorg_infos[0].split_height).toBeDefined();
    } finally {
      await stopNode(proc);
    }
  },
  { timeout: 120000 },
);

test(
  "blocksBufferFetchLoop writes catastrophic_reorg and throws on unrecoverable reorg",
  async () => {
    await killLeftoverMonerod();
    await cleanupReorgDir();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text()) as Keypair[];
    const address = kp[0].view_key.mainnet_primary;
    const scan_settings_path = `${REORG_DIR}/buffer-cat-reorg.json`;

    const proc1 = await startNode();
    try {
      await waitForNode();
      await generateBlocks(address, 20);

      const controller1 = new AbortController();
      const loop1 = blocksBufferFetchLoop(
        NODE_URL,
        0,
        scan_settings_path,
        controller1.signal,
      );
      // let it initialise and fetch some blocks
      await Bun.sleep(1000);
      await generateBlocks(address, 20);
      await Bun.sleep(3000);
      controller1.abort();
      await loop1;
    } finally {
      await stopNode(proc1);
    }

    const proc2 = await startNode();
    try {
      await waitForNode();
      await generateBlocks(address, 20);

      let threw = false;
      try {
        const controller2 = new AbortController();
        const loop2 = blocksBufferFetchLoop(
          NODE_URL,
          0,
          scan_settings_path,
          controller2.signal,
        );
        // it should detect catastrophic reorg and throw
        const timeout = setTimeout(() => controller2.abort(), 8000);
        await loop2;
        clearTimeout(timeout);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      const connStatus =
        await readConnectionStatusDefaultLocation(scan_settings_path);
      expect(connStatus?.last_packet.status).toBe("catastrophic_reorg");
    } finally {
      await stopNode(proc2);
    }
  },
  { timeout: 60000 },
);
