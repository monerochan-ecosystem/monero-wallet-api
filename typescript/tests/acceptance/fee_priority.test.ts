import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { makeTestKeyPair, openWallets, writeScanSettings } from "../../dist/xmr3";

const run = Bun.env.RUN_FEE_PRIORITY_REGTEST === "1" ? test : test.skip;
const out = resolve("test-data/fee-priority-regtest");

function readRingCtFee(hex: string) {
  const bytes = Buffer.from(hex, "hex");
  let offset = 0;

  function byte() {
    const value = bytes[offset++];
    if (value === undefined) throw new Error("unexpected end of transaction");
    return value;
  }

  function varint() {
    let value = 0n;
    for (let shift = 0n; shift < 64n; shift += 7n) {
      const part = byte();
      value |= BigInt(part & 0x7f) << shift;
      if (part < 0x80) return value;
    }
    throw new Error("invalid transaction varint");
  }

  expect(varint()).toBe(2n);
  expect(varint()).toBe(0n);
  const inputs = Number(varint());
  for (let i = 0; i < inputs; i++) {
    expect(byte()).toBe(2);
    expect(varint()).toBe(0n);
    const ringSize = Number(varint());
    for (let j = 0; j < ringSize; j++) varint();
    offset += 32;
  }

  const outputs = Number(varint());
  expect(outputs).toBe(2);
  for (let i = 0; i < outputs; i++) {
    expect(varint()).toBe(0n);
    const tag = byte();
    expect([2, 3]).toContain(tag);
    offset += tag === 3 ? 33 : 32;
  }

  const extraSize = Number(varint());
  offset += extraSize;
  expect(byte()).toBe(6); // clsag with bulletproofs+
  return { fee: varint(), weight: BigInt(bytes.length) };
}

run("signed sweeps encode the requested fee and regtest mines the elevated sweep", async () => {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop();

  const nodeUrl = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([
    Bun.env.MONEROD_PATH ?? "tests/moneronode/monerod",
    "--regtest", "--offline", "--fixed-difficulty", "1",
    "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", String(port),
    "--p2p-bind-port", "0", "--non-interactive",
  ], { stdout: "ignore", stderr: "inherit" });

  async function request(path: string, body: object): Promise<unknown> {
    const response = await fetch(nodeUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`node returned ${response.status} for ${path}`);
    return response.json();
  }

  async function rpc<T>(method: string, params = {}): Promise<T> {
    const response = await request("/json_rpc", { jsonrpc: "2.0", id: "test", method, params }) as {
      result?: T;
      error?: { message: string };
    };
    if (response.result === undefined) throw new Error(response.error?.message ?? `missing result for ${method}`);
    return response.result;
  }

  let wallets: Awaited<ReturnType<typeof openWallets>> | undefined;
  const key = await makeTestKeyPair();
  const sender = key.view_key.mainnet_primary;
  Bun.env["vk" + sender] = key.view_key.view_key;
  Bun.env["sk" + sender] = key.spend_key;

  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`regtest node exited with ${proc.exitCode}`);
      try {
        await rpc("get_info");
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(100);
      }
    }

    await rpc("generateblocks", { amount_of_blocks: 1000, wallet_address: sender });
    const settings = out + "/ScanSettings.json";
    await writeScanSettings({ wallets: [{ primary_address: sender }], node_url: nodeUrl, start_height: 0 }, settings);
    const synced = Promise.withResolvers<void>();
    wallets = await openWallets({
      scan_settings_path: settings,
      pathPrefix: out + "/",
      no_stats: true,
      notifyMasterChanged: ({ newCache }) => {
        if ((newCache.scanned_ranges.at(-1)?.end ?? 0) >= 1000) synced.resolve();
      },
    });
    await Promise.race([synced.promise, Bun.sleep(30_000).then(() => { throw new Error("wallet did not sync"); })]);

    const wallet = wallets!.wallets[0]!;
    wallet.decoyRetry = true;
    const [input] = wallet.spendableInputs();
    if (!input) throw new Error("missing spendable input");
    const receiver = (await makeTestKeyPair()).view_key.mainnet_primary;
    const estimate = await wallet.getFeeEstimate();
    const signedDefault = await wallet.signTransaction(await wallet.sweepToExternalWallet(receiver, [input]));
    const signedElevated = await wallet.signTransaction(await wallet.sweepToExternalWallet(receiver, [input], "elevated"));
    const defaultTx = readRingCtFee(signedDefault);
    const elevatedTx = readRingCtFee(signedElevated);

    const mask = BigInt(estimate.quantization_mask);
    const expectedFee = (weight: bigint, rate: number) => ((weight * BigInt(rate) + mask - 1n) / mask) * mask;
    await Bun.write(out + "/default.hex", signedDefault);
    await Bun.write(out + "/elevated.hex", signedElevated);
    expect(defaultTx.fee).toBe(expectedFee(defaultTx.weight, estimate.fees![0]!));
    expect(elevatedTx.fee).toBe(expectedFee(elevatedTx.weight, estimate.fees![2]!));
    expect(elevatedTx.fee).toBeGreaterThan(defaultTx.fee);

    expect((await wallet.sendTransaction(signedElevated)).status).toBe("OK");
    const miningDeadline = Date.now() + 10_000;
    for (;;) {
      const pool = await request("/get_transaction_pool", {}) as {
        transactions?: { id_hash: string; tx_blob: string }[];
      };
      const accepted = pool.transactions?.find((tx) => tx.tx_blob === signedElevated);
      if (accepted) {
        const template = await rpc<{ blocktemplate_blob: string }>("get_block_template", {
          wallet_address: sender,
          reserve_size: 1,
        });
        // the only pool transaction must be the last hash in the block template
        if (template.blocktemplate_blob.endsWith(accepted.id_hash)) break;
      }
      if (Date.now() >= miningDeadline) throw new Error("sweep did not enter the block template");
      await Bun.sleep(100);
    }
    const { blocks } = await rpc<{ blocks: string[] }>("generateblocks", { amount_of_blocks: 1, wallet_address: sender });
    const { tx_hashes } = await rpc<{ tx_hashes: string[] }>("get_block", { hash: blocks[0] });
    expect(tx_hashes).toHaveLength(1);
    const { txs } = await request("/get_transactions", { txs_hashes: tx_hashes }) as {
      txs: { as_hex: string; in_pool: boolean }[];
    };
    expect(txs[0]).toMatchObject({ as_hex: signedElevated, in_pool: false });
  } finally {
    try {
      wallets?.unwatchConnectionStatus();
      await wallets?.stopWorker();
    } finally {
      proc.kill();
      await proc.exited;
      delete Bun.env["vk" + sender];
      delete Bun.env["sk" + sender];
    }
  }
}, { timeout: 150_000 });
