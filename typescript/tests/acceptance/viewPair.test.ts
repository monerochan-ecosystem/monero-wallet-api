import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { makeTestKeyPair, openWallets, ViewPair, writeScanSettings } from "../../dist/xmr3";

const run = Bun.env.RUN_VIEWPAIR_REGTEST === "1" ? test : test.skip;
const out = resolve("test-data/view-pair-regtest");

run("one ViewPair scans a signed payment after registering its subaddress; a timelocked coinbase throws unless allow_timelock is true", async () => {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const sender = await makeTestKeyPair();
  const receiver = (await makeTestKeyPair()).view_key;
  const primary = sender.view_key.mainnet_primary;
  const receiverView = await ViewPair.create(receiver.mainnet_primary, receiver.view_key);
  const destination = receiverView["makeSubaddressRaw"](1, 0);
  const scanner = await ViewPair.create(receiver.mainnet_primary, receiver.view_key);

  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop();
  const nodeUrl = `http://127.0.0.1:${port}`;
  const settings = out + "/ScanSettings.json";
  await writeScanSettings({ node_url: nodeUrl, start_height: 0, wallets: [{ primary_address: primary }] }, settings);

  const proc = Bun.spawn([
    Bun.env.MONEROD_PATH ?? "tests/moneronode/monerod",
    "--regtest", "--offline", "--fixed-difficulty", "1",
    "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", String(port),
    "--non-interactive",
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();

  async function rpc(method: string, params = {}, timeout = 60_000) {
    const response = await fetch(nodeUrl + "/json_rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "test", method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
    const { result, error } = await response.json();
    if (!result || error) throw new Error(`${method}: ${error?.message ?? "missing result"}`);
    return result;
  }

  let wallets: Awaited<ReturnType<typeof openWallets>> | undefined;
  Bun.env["vk" + primary] = sender.view_key.view_key;
  Bun.env["sk" + primary] = sender.spend_key;
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`regtest node exited with ${proc.exitCode}`);
      try {
        await rpc("get_info", {}, 1000);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(100);
      }
    }

    await rpc("generateblocks", { amount_of_blocks: 1000, wallet_address: primary });
    const synced = Promise.withResolvers<void>();
    wallets = await openWallets({
      scan_settings_path: settings,
      pathPrefix: out + "/",
      no_stats: true,
      notifyMasterChanged: ({ newCache }) => {
        if ((newCache.scanned_ranges.at(-1)?.end ?? 0) >= 1000) synced.resolve();
      },
    });
    const wallet = wallets?.wallets[0];
    if (!wallet) throw new Error("sender wallet did not open");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        synced.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("sender wallet did not sync")), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    const amount = "100000000000";
    wallet.decoyRetry = true;
    const signed = await wallet.signTransaction(await wallet.makeStandardTransaction(destination, amount));
    await Bun.write(out + "/payment.hex", signed);

    expect(scanner.scanTransaction(signed).outputs).toEqual([]);
    scanner.registerScanSubaddresses([[1, 0]]);
    const result = scanner.scanTransaction(signed);
    await Bun.write(out + "/scan.json", JSON.stringify(result, null, 2));
    expect(result.outputs).toEqual([expect.objectContaining({ amount, subaddress_index: [1, 0] })]);

    // a coinbase is timelocked for 60 blocks. monerod sends it in two parts; its prunable part is empty.
    const block = await rpc("get_block", { height: 1000 });
    const txs = await (await fetch(nodeUrl + "/get_transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txs_hashes: [block.miner_tx_hash], split: true }),
    })).json();
    const coinbase = txs.txs[0].pruned_as_hex + txs.txs[0].prunable_as_hex;
    await Bun.write(out + "/coinbase.hex", coinbase);
    const miner = await ViewPair.create(primary, sender.view_key.view_key);
    expect(() => miner.scanTransaction(coinbase)).toThrow("timelocked transaction");
    const allowed = miner.scanTransaction(coinbase, true);
    expect(allowed.unlock_time).toBe("1060");
    expect(allowed.outputs).toEqual([expect.objectContaining({ amount: String(block.block_header.reward) })]);
  } finally {
    try {
      wallets?.unwatchConnectionStatus();
      await wallets?.stopWorker();
    } finally {
      proc.kill();
      await proc.exited;
      await Bun.write(out + "/node-stdout.log", await stdout);
      await Bun.write(out + "/node-stderr.log", await stderr);
      delete Bun.env["vk" + primary];
      delete Bun.env["sk" + primary];
    }
  }
}, { timeout: 150_000 });
