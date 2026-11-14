import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  makeTestKeyPair, openWallets, writeScanSettings, readCacheFileDefaultLocation,
  type ManyScanCachesOpened,
} from "../../dist/xmr3";

const run = Bun.env.RUN_SUBADDRESS_REGTEST === "1" ? test : test.skip;
const MONEROD_PATH = "tests/moneronode/monerod";
const RPC_PORT = 18081;
const NODE_URL = `http://127.0.0.1:${RPC_PORT}`;
const OUT = resolve("test-data/subaddress-live");
const SCAN_SETTINGS_PATH = OUT + "/ScanSettings.json";

async function startNode() {
  return Bun.spawn(
    [MONEROD_PATH, "--regtest", "--offline", "--fixed-difficulty", "1",
      "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", String(RPC_PORT), "--non-interactive"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
}
async function stopNode(proc: Bun.Subprocess): Promise<void> {
  proc.kill(9);
  await proc.exited;
}
async function waitForNode(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${NODE_URL}/json_rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }) });
      if (resp.ok && (await resp.json()).result?.height !== undefined) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw Error("Node did not become ready within timeout");
}
async function generateBlocks(address: string, count: number): Promise<void> {
  const resp = await fetch(`${NODE_URL}/json_rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "generateblocks", params: { amount_of_blocks: count, wallet_address: address } }) });
  if (!resp.ok) throw Error(`generateblocks RPC failed: ${resp.statusText}`);
  const result = await resp.json();
  if (result.error) throw Error(`generateblocks error: ${JSON.stringify(result.error)}`);
}

run("a subaddress added through openWallets receives a payment without restarting the scan", async () => {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const keys = [await makeTestKeyPair(), await makeTestKeyPair()];
  for (const key of keys) {
    Bun.env["vk" + key.view_key.mainnet_primary] = key.view_key.view_key;
    Bun.env["sk" + key.view_key.mainnet_primary] = key.spend_key;
  }
  const sender = keys[0]!.view_key.mainnet_primary;
  const receiver = keys[1]!.view_key.mainnet_primary;
  await writeScanSettings({ wallets: [{ primary_address: sender }, { primary_address: receiver, subaddress_index: 1 }], node_url: NODE_URL, start_height: 0, logs: "file", logs_include: ["logBufStatus", "handleCpuboundScan"] }, SCAN_SETTINGS_PATH);
  const proc = await startNode();
  let mco: ManyScanCachesOpened | undefined;
  const workerErrors: string[] = [];
  const json = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? String(v) : v, 2);
  try {
    await waitForNode();
    let initialDone!: () => void;
    const initialSync = new Promise<void>((done) => { initialDone = done; });
    let paymentDone!: () => void;
    const paymentScan = new Promise<void>((done) => { paymentDone = done; });
    mco = await openWallets({ scan_settings_path: SCAN_SETTINGS_PATH, pathPrefix: OUT + "/", no_stats: true,
      workerError: (error) => workerErrors.push(String(error)),
      notifyMasterChanged: ({ newCache }) => {
        if (newCache.primary_address === sender && (newCache.scanned_ranges.at(-1)?.end ?? 0) >= 1000) initialDone();
        if (newCache.primary_address === receiver && (newCache.scanned_ranges.at(-1)?.end ?? 0) >= 1001) paymentDone();
      },
    });
    await generateBlocks(sender, 1000);
    await initialSync;
    const subaddress = await mco.wallets[1]!.makeSubaddress();
    expect(subaddress.minor).toBe(2);
    expect((await Bun.file(SCAN_SETTINGS_PATH).json()).wallets[1].subaddress_index).toBe(2);
    mco.wallets[0]!.decoyRetry = true;
    const unsigned = await mco.wallets[0]!.makeStandardTransaction(subaddress.address, "100000000000");
    const signed = await mco.wallets[0]!.signTransaction(unsigned);
    const result = await mco.wallets[0]!.sendTransaction(signed);
    expect(result.status).toBe("OK");
    await generateBlocks(sender, 1);
    await paymentScan;
    const cache = (await readCacheFileDefaultLocation(receiver, OUT + "/"))!;
    const received = Object.values(cache.outputs).filter((output) => output.subaddress_index === subaddress.minor);
    await Bun.write(OUT + "/results.json", json({ subaddress, received, scanRanges: cache.scanned_ranges, workerErrors }));
    expect(received.map((output) => String(output.amount))).toEqual(["100000000000"]);
    expect(workerErrors).toEqual([]);
  } finally {
    if (mco) { mco.unwatchConnectionStatus(); await mco.stopWorker(); }
    await stopNode(proc);
    await Bun.write(OUT + "/node-stdout.log", await new Response(proc.stdout).text());
    await Bun.write(OUT + "/node-stderr.log", await new Response(proc.stderr).text());
    for (const key of keys) { delete Bun.env["vk" + key.view_key.mainnet_primary]; delete Bun.env["sk" + key.view_key.mainnet_primary]; }
  }
}, { timeout: 120000 });
