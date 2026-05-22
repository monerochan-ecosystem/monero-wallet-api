import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import {
  ScanCacheOpened,
  ManyScanCachesOpened,
  ScanSettingsOpened,
  openWallets,
  writeScanSettings,
  makeTestKeyPair,
  type ConnectionStatus,
} from "../../../dist/api";

const OUT = "test-data/scanCacheOpened";
const MONEROD = "tests/moneronode/monerod";
const PORT = 18093;
const URL = `http://127.0.0.1:${PORT}`;

async function waitNode() {
  const dl = Date.now() + 30000;
  while (Date.now() < dl) {
    try {
      const r = await fetch(`${URL}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
      });
      if (r.ok && (await r.json()).result?.height) break;
    } catch {}
    await Bun.sleep(500);
  }
}

async function rpc(method: string, params: any) {
  const resp = await fetch(`${URL}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
  });
  if (!resp.ok) throw new Error(`rpc ${method} failed: ${resp.statusText}`);
  return await resp.json();
}

interface KeypairResult {
  addr: string;
  vk: string;
  sk: string;
}
async function makeKeypair(): Promise<KeypairResult> {
  const kp = await makeTestKeyPair();
  const a = kp.view_key.mainnet_primary;
  Bun.env[`vk${a}`] = kp.view_key.view_key;
  Bun.env[`sk${a}`] = kp.spend_key;
  return { addr: a, vk: kp.view_key.view_key, sk: kp.spend_key };
}

let kp1: KeypairResult;
let proc: any;

beforeAll(async () => {
  await Bun.$`pgrep monerod && kill -9 $(pgrep monerod) 2>/dev/null; echo "monerod process cleanup done"`;
  proc = Bun.spawn(
    [
      MONEROD,
      "--regtest",
      "--offline",
      "--fixed-difficulty",
      "1",
      "--rpc-bind-ip",
      "127.0.0.1",
      "--rpc-bind-port",
      String(PORT),
      "--non-interactive",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  await Bun.sleep(500);
  await waitNode();

  await rpc("generateblocks", {
    amount_of_blocks: 200,
    wallet_address: (await makeKeypair()).addr,
  });
  kp1 = await makeKeypair();
  await rpc("generateblocks", {
    amount_of_blocks: 10,
    wallet_address: kp1.addr,
  });
}, 30000);

test("a: settings getters/setters chain from ScanCacheOpened through to file", async () => {
  const dir = `${OUT}/a`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);
  await sso.addViewWallet(kp1.addr, kp1.vk, {
    wallet_name: "test",
  });
  // set initial node url so the scan works
  await sso.setNodeUrl(URL);

  // create with no_worker so we can test setters without a real worker
  const sco = await ScanCacheOpened.create({
    primary_address: kp1.addr,
    scan_settings_path: path,
    no_worker: true,
    no_stats: true,
  });

  // getters match the underlying ScanSettingsOpened
  expect(sco.merchant_confirmations).toBe(sso.merchant_confirmations);
  expect(sco.cpu_worker_count).toBe(sso.cpu_worker_count);
  expect(sco.logs).toBe(sso.logs);
  expect(sco.logs_include).toBe(sso.logs_include);
  expect(sco.logs_exclude).toBe(sso.logs_exclude);

  // set merchant_confirmations through ScanCacheOpened
  await sco.setMerchantConfirmations(10);
  expect(sco.merchant_confirmations).toBe(10);
  let raw = JSON.parse(await Bun.file(path).text());
  expect(raw.merchant_confirmations).toBe(10);

  // set cpu_worker_count through sco
  await sco.setCpuWorkerCount(2);
  expect(sco.cpu_worker_count).toBe(2);
  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.cpu_worker_count).toBe(2);

  // set log settings on sco
  await sco.setLogSettings("file", ["coordinatorMain"]);
  expect(sco.logs).toBe("file");
  expect(sco.logs_include).toEqual(["coordinatorMain"]);
  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.logs).toBe("file");
  expect(raw.logs_include).toEqual(["coordinatorMain"]);

  // change node url via sco
  const newUrl = "http://127.0.0.1:18081";
  await sco.changeNodeUrl(newUrl);
  expect(sco.node_url).toBe(newUrl);
  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.node_url).toBe(newUrl);

  // change start height on sco
  await sco.changeStartHeight(100);
  expect(sco.start_height).toBe(100);
  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.start_height).toBe(100);
});

test("b: settings getters/setters chain from ManyScanCachesOpened through to file", async () => {
  const dir = `${OUT}/b`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);
  await sso.addViewWallet(kp1.addr, kp1.vk, {
    wallet_name: "test",
  });
  await sso.setNodeUrl(URL);

  // create directly
  const msco = await ManyScanCachesOpened.create({
    scan_settings_path: path,
    no_worker: true,
    no_stats: true,
  });
  if (!msco) throw new Error("expected ManyScanCachesOpened instance");

  // getters match on msco
  expect(msco.merchant_confirmations).toBe(sso.merchant_confirmations);
  expect(msco.cpu_worker_count).toBe(sso.cpu_worker_count);
  expect(msco.logs).toBe(sso.logs);
  expect(msco.logs_include).toBe(sso.logs_include);
  expect(msco.logs_exclude).toBe(sso.logs_exclude);

  // set merchant_confirmations through msco
  await msco.setMerchantConfirmations(5);
  expect(msco.merchant_confirmations).toBe(5);
  let raw = JSON.parse(await Bun.file(path).text());
  expect(raw.merchant_confirmations).toBe(5);

  // set cpu_worker_count
  await msco.setCpuWorkerCount(4);
  expect(msco.cpu_worker_count).toBe(4);
  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.cpu_worker_count).toBe(4);

  // set log settings
  await msco.setLogSettings("file", ["coordinatorMain", "handleCpuboundScan"]);
  expect(msco.logs).toBe("file");
  expect(msco.logs_include).toEqual(["coordinatorMain", "handleCpuboundScan"]);
  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.logs).toBe("file");
  expect(raw.logs_include).toEqual(["coordinatorMain", "handleCpuboundScan"]);

  // change node url
  const newUrl = "http://127.0.0.1:18081";
  await msco.changeNodeUrl(newUrl);
  expect(msco.node_url).toBe(newUrl);
  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.node_url).toBe(newUrl);

  // change start height
  await msco.changeStartHeight(200);
  expect(msco.start_height).toBe(200);
  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.start_height).toBe(200);

  // cleanup
  msco.stopWorker();
});

test("c: worker restart on setting change via openWallets", async () => {
  const dir = `${OUT}/c`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  // include functions that fire during worker startup
  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }],
      node_url: URL,
      start_height: 0,
      logs: "file",
      logs_include: ["createWebworker", "coordinatorMainWorker"],
    },
    path,
  );

  // open wallets, starts the coordinator + cpubound workers
  const wallets = await openWallets({
    scan_settings_path: path,
    pathPrefix: `${dir}/`,
  });
  if (!wallets) throw new Error("expected wallets");

  // wait for workers to boot and log flusher to write
  await Bun.sleep(4000);

  // collect log files from first worker start
  const filesBefore = readdirSync(dir).filter((f) => f.endsWith(".log"));
  expect(filesBefore.length).toBeGreaterThan(0);

  // read the coordinator log to verify worker startup messages
  const coordLogBefore = filesBefore.find((f: string) =>
    f.startsWith("coordinator"),
  );
  expect(coordLogBefore).toBeDefined();
  const coordContentBefore = await Bun.file(`${dir}/${coordLogBefore}`).text();
  // coordinator logs cpuPorts count on startup
  expect(coordContentBefore).toContain("cpuPorts");

  // read the mainthread log to verify worker startup
  const mainLogBefore = filesBefore.find((f: string) =>
    f.startsWith("mainthread"),
  );
  expect(mainLogBefore).toBeDefined();
  const mainContentBefore = await Bun.file(`${dir}/${mainLogBefore}`).text();
  // createWebworker logs the startup message
  expect(mainContentBefore).toContain("coordinator worker started");

  // change node url, worker stops, new worker starts
  await wallets.changeNodeUrl(URL);

  // wait for new worker to boot and flusher to write
  await Bun.sleep(4000);

  // collect log files again
  const filesAfter = readdirSync(dir).filter((f) => f.endsWith(".log"));
  // new log files should have appeared (new timestamps)
  expect(filesAfter.length).toBeGreaterThan(filesBefore.length);

  // find log files that weren't there before
  const newFiles = filesAfter.filter((f: string) => !filesBefore.includes(f));
  expect(newFiles.length).toBeGreaterThan(0);

  // read a new coordinator log to verify the new worker logged startup
  const newCoordLog = newFiles.find((f: string) => f.startsWith("coordinator"));
  expect(newCoordLog).toBeDefined();
  const coordContentAfter = await Bun.file(`${dir}/${newCoordLog}`).text();
  // new coordinator logs cpuPorts on startup
  expect(coordContentAfter).toContain("cpuPorts");

  // new mainthread log verifies createWebworker was called again
  const newMainLog = newFiles.find((f: string) => f.startsWith("mainthread"));
  expect(newMainLog).toBeDefined();
  const mainContentAfter = await Bun.file(`${dir}/${newMainLog}`).text();
  expect(mainContentAfter).toContain("coordinator worker started");

  // change log settings, worker stops, new worker starts
  await wallets.setLogSettings("file", ["createWebworker"]);
  await Bun.sleep(4000);

  const filesFinal = readdirSync(dir).filter((f) => f.endsWith(".log"));
  expect(filesFinal.length).toBeGreaterThan(filesAfter.length);

  let raw = JSON.parse(await Bun.file(path).text());
  expect(raw.logs_include).toEqual(["createWebworker"]);

  wallets.stopWorker();
}, 60000);

test("d: connection status watcher fires and caches correctly with live node", async () => {
  const dir = `${OUT}/d`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }],
      node_url: URL,
      start_height: 0,
    },
    path,
  );

  let callCount = 0;
  let lastStatus: ConnectionStatus | null = null;

  const wallets = await openWallets({
    scan_settings_path: path,
    pathPrefix: `${dir}/`,
    connectionStatusIntervalMs: 500,
    onConnectionStatusChange: (status) => {
      callCount++;
      lastStatus = status;
    },
    no_stats: true,
  });
  if (!wallets) throw new Error("expected wallets");

  // wait for the fetcher to write real data (daemon_height > 0)
  let daemonHeight = 0;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    if (wallets.connectionStatusOpened.connectionStatus?.sync?.daemon_height) {
      daemonHeight =
        wallets.connectionStatusOpened.connectionStatus.sync.daemon_height;
      break;
    }
  }
  expect(daemonHeight).toBeGreaterThan(0);
  expect(callCount).toBeGreaterThanOrEqual(1);
  expect(lastStatus).not.toBeNull();
  expect(lastStatus!.last_packet.status).toBe("OK");

  // cached value is accessible and matches
  expect(wallets.connectionStatus?.last_packet.status).toBe("OK");
  expect(
    wallets.connectionStatusOpened.connectionStatus?.last_packet.status,
  ).toBe("OK");
  expect(wallets.connectionStatusOpened.isConnected).toBe(true);

  // unwatch stops updates
  const countBeforeUnwatch = callCount;
  wallets.unwatchConnectionStatus();
  await Bun.sleep(1000);
  expect(callCount).toBe(countBeforeUnwatch);

  wallets.stopWorker();
}, 30000);

test("e: addViewWallet and removeWallet on ManyScanCachesOpened", async () => {
  const dir = `${OUT}/e`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  const sso = await ScanSettingsOpened.create(path);
  await sso.addViewWallet(kp1.addr, kp1.vk, { wallet_name: "first" });
  await sso.setNodeUrl(URL);
  await sso.setStartHeight(210);

  await rpc("generateblocks", {
    amount_of_blocks: 10,
    wallet_address: kp1.addr,
  });
  let resolveSync: () => void;
  const synced = new Promise<void>((r) => {
    resolveSync = r;
  });

  const wallets = await openWallets({
    scan_settings_path: path,
    pathPrefix: `${dir}/`,
    notifyMasterChanged: (params) => {
      const last = params.newCache.scanned_ranges.at(-1);
      if (last && last.end >= 10) resolveSync();
    },
  });
  if (!wallets) throw new Error("expected wallets");

  expect(wallets.wallets.length).toBe(1);
  expect(wallets.wallets[0].wallet_name).toBe("first");
  expect(wallets.wallets[0].primary_address).toBe(kp1.addr);

  // wait for scan to catch up
  await synced;

  // add second wallet
  const kp2 = await makeKeypair();
  await wallets.addViewWallet(kp2.addr, kp2.vk, {
    wallet_name: "second",
  });

  expect(wallets.wallets.length).toBe(2);
  expect(wallets.wallets[0].wallet_name).toBe("first");
  expect(wallets.wallets[1].wallet_name).toBe("second");

  // scan still works after rebuild (notifyMasterChanged keeps firing)

  // verify on disk
  let raw = JSON.parse(await Bun.file(path).text());
  expect(raw.wallets.length).toBe(2);

  // remove first wallet
  await wallets.removeWallet(kp1.addr);
  expect(wallets.wallets.length).toBe(1);
  expect(wallets.wallets[0].wallet_name).toBe("second");

  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.wallets.length).toBe(1);

  // add spend wallet
  const entropy = new Uint8Array(64);
  crypto.getRandomValues(entropy);
  await wallets.addSpendWallet(entropy, { wallet_name: "spendy" });

  expect(wallets.wallets.length).toBe(2);
  expect(wallets.wallets[1].wallet_name).toBe("spendy");
  expect(wallets.wallets[1].primary_address).toBeDefined();

  raw = JSON.parse(await Bun.file(path).text());
  expect(raw.wallets.length).toBe(2);

  wallets.stopWorker();
}, 30000);

test("f: isConnected becomes false when node goes down", async () => {
  const dir = `${OUT}/f`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  const path = `${dir}/ScanSettings.json`;
  await writeScanSettings(
    {
      wallets: [{ primary_address: kp1.addr }],
      node_url: URL,
      start_height: 0,
    },
    path,
  );

  let lastStatus: ConnectionStatus | null = null;
  const wallets = await openWallets({
    scan_settings_path: path,
    pathPrefix: `${dir}/`,
    connectionStatusIntervalMs: 500,
    onConnectionStatusChange: (s) => {
      lastStatus = s;
    },
    no_stats: true,
  });
  if (!wallets) throw new Error("expected wallets");

  // wait for initial connection
  await Bun.sleep(2000);
  expect(wallets.connectionStatusOpened.isConnected).toBe(true);

  // kill monerod, fetcher should fail on next rpc
  proc.kill(9);

  // wait for the next fetch attempt to fail and write connection_failed
  let connected = true;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    if (!wallets.connectionStatusOpened.isConnected) {
      connected = false;
      break;
    }
  }
  expect(connected).toBe(false);
  expect(lastStatus!.last_packet.status).not.toBe("OK");

  wallets.stopWorker();
}, 30000);

afterAll(() => {
  if (proc) {
    try {
      proc.kill(9);
    } catch {}
    try {
      proc.exited;
    } catch {}
  }
});
