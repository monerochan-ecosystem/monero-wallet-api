import { test, expect, beforeAll } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import {
  get_info,
  writeScanSettings,
  openWallets,
  scanWallets,
  cacheFileDefaultLocation,
  readConnectionStatusDefaultLocation,
} from "../wallet-api/api";
import {
  makeTestKeyPair,
  type Keypair,
} from "../wallet-api/keypairs-seeds/keypairs";
import type { ScanSettings } from "../wallet-api/scanning-syncing/scanSettings";

const MONERONODE_DIR = "tests/moneronode";
const MONEROD_PATH = `${MONERONODE_DIR}/monerod`;
const KEYPAIRS_PATH = `${MONERONODE_DIR}/keypairs.json`;
const SCAN_SETTINGS_PATH = `${MONERONODE_DIR}/ScanSettings.json`;
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
  const reader = binResp.body!.getReader();
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

beforeAll(
  async () => {
    await killLeftoverMonerod();
    await setupMoneroNode();
    await setupKeypairFixtures();
  },
  { timeout: 600000 },
);

test(
  "start monero regtest node and verify RPC responds",
  async () => {
    const proc = await startNode();
    try {
      await waitForNode();
      const info = await get_info(NODE_URL);
      expect(info.height).toBe(1);
      expect(info.status).toBe("OK");
    } finally {
      await stopNode(proc);
    }
  },
  { timeout: 60000 },
);

test(
  "stop and restart monero regtest node",
  async () => {
    const proc1 = await startNode();
    try {
      await waitForNode();
      const info1 = await get_info(NODE_URL);
      expect(info1.height).toBe(1);
      expect(info1.status).toBe("OK");
    } finally {
      await stopNode(proc1);
    }

    await Bun.sleep(1500);

    const proc2 = await startNode();
    try {
      await waitForNode();
      const info2 = await get_info(NODE_URL);
      expect(info2.height).toBe(1);
      expect(info2.status).toBe("OK");
    } finally {
      await stopNode(proc2);
    }
  },
  { timeout: 60000 },
);

test(
  "mine 1000 blocks then restart with fresh chain",
  async () => {
    const keypairs = JSON.parse(
      await Bun.file(KEYPAIRS_PATH).text(),
    ) as Keypair[];
    const address = keypairs[0].view_key.mainnet_primary;

    const proc = await startNode();
    try {
      await waitForNode();
      await generateBlocks(address, 1000);
      const info = await get_info(NODE_URL);
      expect(info.height).toBe(1001);
      expect(info.status).toBe("OK");
    } finally {
      await stopNode(proc);
    }
    const proc2 = await startNode();
    try {
      await waitForNode();
      const info2 = await get_info(NODE_URL);
      expect(info2.height).toBe(1);
      expect(info2.status).toBe("OK");
    } finally {
      await stopNode(proc2);
    }
  },
  { timeout: 120000 },
);

test(
  "scan to populate cache, pop blocks, detect catastrophic reorg",
  async () => {
    const keypairs = JSON.parse(
      await Bun.file(KEYPAIRS_PATH).text(),
    ) as Keypair[];
    const address = keypairs[0].view_key.mainnet_primary;

    const proc = await startNode();
    try {
      await waitForNode();

      // open wallets
      const opened = (await openWallets({
        scan_settings_path: SCAN_SETTINGS_PATH,
        pathPrefix: `${MONERONODE_DIR}/`,
        no_worker: true,
      }))!;
      expect(opened.wallets.length).toBe(10);

      // mine the first batch, then start scan while mining the rest
      await generateBlocks(address, 10);

      const abort = new AbortController();
      let scanCaughtUp = false;
      const scanPromise = scanWallets(
        (params) => {
          if (params.newCache.daemon_height >= 21) {
            scanCaughtUp = true;
            abort.abort();
          }
        },
        abort.signal,
        SCAN_SETTINGS_PATH,
        `${MONERONODE_DIR}/`,
      );

      await generateBlocks(address, 10);
      await scanPromise.catch(() => {});
      expect(scanCaughtUp).toBe(true);

      // cache file now exists with scanned_ranges up to height 21
      const cachePath = cacheFileDefaultLocation(address, `${MONERONODE_DIR}/`);
      expect(await Bun.file(cachePath).exists()).toBe(true);

      // pop 10 blocks, chain rewinds to height 11
      const popResp = await fetch(`${NODE_URL}/pop_blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nblocks: 10 }),
      });
      expect(popResp.ok).toBe(true);
      expect((await get_info(NODE_URL)).height).toBe(11);

      // re-scan, the old cached hashes (up to 21) wont match the chain at 11,
      // triggering handleReorg or catastrophic reorg
      let reorgCache: any = null;
      const abort2 = new AbortController();
      const scanPromise2 = scanWallets(
        (params) => {
          reorgCache = params.newCache;
          abort2.abort();
        },
        abort2.signal,
        SCAN_SETTINGS_PATH,
        `${MONERONODE_DIR}/`,
      );
      await scanPromise2.catch(() => {});
      expect(reorgCache).not.toBeNull();

      // after the reorg, evidence should be in the cache file or connection status file
      const cacheAfter = await Bun.file(cachePath).text();
      const cacheJson = JSON.parse(cacheAfter);
      const connStatus =
        await readConnectionStatusDefaultLocation(SCAN_SETTINGS_PATH);

      // at least one of these must show the reorg
      const cacheHasReorg = cacheJson.reorg_info !== undefined;
      const connHasCatastrophic =
        connStatus?.last_packet.status === "catastrophic_reorg";

      if (!cacheHasReorg && !connHasCatastrophic) {
        console.log("Cache file contents:", cacheAfter);
        console.log("Connection status:", JSON.stringify(connStatus));
      }

      expect(cacheHasReorg || connHasCatastrophic).toBe(true);
    } finally {
      await stopNode(proc);
    }

    // clean up cache and status files
    for (const kp of keypairs) {
      const cachePath = cacheFileDefaultLocation(
        kp.view_key.mainnet_primary,
        `${MONERONODE_DIR}/`,
      );
      await rm(cachePath, { force: true }).catch(() => {});
    }
    const connStatusPath = `ConnectionStatus-${SCAN_SETTINGS_PATH}`;
    await rm(connStatusPath, { force: true }).catch(() => {});
  },
  { timeout: 120000 },
);
