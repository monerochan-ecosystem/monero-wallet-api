import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  openWallets,
  ScanCacheOpened,
  type ManyScanCachesOpened,
  readCacheFileDefaultLocation,
  type ScanCache,
  ViewPair,
  type GetBlocksBinBufferItem,
  type Output,
  type SendRawTransactionResult,
} from "../../../dist/xmr3";
import * as coordinator from "../../../dist/xmr3";
import * as background from "../../../dist/xmr3";
import * as blocks from "../../../dist/xmr3";
import * as rpc from "../../../dist/xmr3";
import * as stats from "../../../dist/xmr3";

const ROOT = resolve("test-data/coordinator-send");
const addresses = ["send-a", "send-b"];
const fee = { status: "OK", fee: 1, quantization_mask: 1, fees: [1] };
const gate = <T = void>() => Promise.withResolvers<T>();
const answer = (status = "OK") => ({ status, reason: status === "OK" ? "" : "test rejection" }) as SendRawTransactionResult;
const stringify = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item, 2);
let restore: (() => void)[];
let runs: ManyScanCachesOpened[];
let stops: number;
let starts: number;
let keys: (string | undefined)[];
let ready: ReturnType<typeof gate>;
let blockInput: ReturnType<typeof gate<GetBlocksBinBufferItem>>;
let messages: number;
let scans: number;
const ports: MessagePort[] = [];

beforeEach(() => {
  runs = [];
  stops = starts = messages = scans = 0;
  ready = gate();
  blockInput = gate<GetBlocksBinBufferItem>();
  keys = addresses.map((address) => Bun.env["vk" + address]);
  for (const address of addresses) Bun.env["vk" + address] = "01".repeat(32);
  const view = spyOn(ViewPair, "create").mockImplementation(async (primary_address) => ({
    primary_address, node_url: "test", addSubaddressesToScanCache: async () => {},
  }) as unknown as ViewPair);
  const info = spyOn(rpc, "get_info").mockResolvedValue({ height: 51 } as Awaited<ReturnType<typeof rpc.get_info>>);
  const setup = spyOn(blocks, "setupBlocksBufferGenerator").mockImplementation(async (params) => ({
    blocksBuffer: [], connection_status: {} as never,
    generator: (async function* () {
      yield { status: "OK", bytes_read: 1, node_url: "test", timestamp: new Date().toISOString(), daemon_height: 51 };
      while (!params.stopSync?.aborted) {
        const item = await Promise.race([
          blockInput.promise,
          new Promise<null>((resolve) => params.stopSync?.addEventListener("abort", () => resolve(null), { once: true })),
        ]);
        if (!item) return;
        blockInput = gate<GetBlocksBinBufferItem>();
        yield item;
      }
    })(),
  }));
  const create = spyOn(background, "createWebworker").mockImplementation(async (onResult, path, prefix) => {
    const controller = new AbortController();
    const cpu = new MessageChannel();
    ports.push(cpu.port1, cpu.port2);
    cpu.port2.onmessage = (event) => {
      if (event.data === "cancel") cpu.port2.postMessage({ type: "Canceled" });
      else {
        cpu.port2.postMessage({ type: "WORKSTART", work_uuid: event.data.work_uuid });
        cpu.port2.postMessage({ type: "Ready", work_uuid: event.data.work_uuid });
      }
    };
    const loop = (async () => {
      for await (const event of coordinator.coordinatorMainMultithreaded(path, prefix, [cpu.port1], controller.signal)) {
        if (event.type === "connection_status") ready.resolve();
        if (event.type !== "scan_ready") continue;
        await onResult?.(structuredClone({ newCache: event.newCache, changed_outputs: event.changed_outputs }));
        if (event.replyPort) {
          event.replyPort.postMessage({ txLogIndex: event.txLogIndex });
          event.replyPort.close();
        } else scans++;
      }
    })();
    return {
      fetchWorker: {} as Worker, cpuWorkers: [], dumpHeaps: async () => [],
      shutdown: async () => { controller.abort(); await loop; },
      terminate: () => { controller.abort(); },
      writeCache: (message: background.TxCacheWriteMessage) => new Promise<number>((resolve, reject) => {
        const channel = new MessageChannel();
        ports.push(channel.port1, channel.port2);
        channel.port1.onmessage = (event) => {
          channel.port1.close();
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.txLogIndex);
        };
        messages++;
        coordinator.queueCacheWrite(new MessageEvent<background.TxCacheWriteMessage>("message", {
          data: structuredClone(message), ports: [channel.port2],
        }));
      }),
    } satisfies background.WorkerSet;
  });
  const originalStop = ScanCacheOpened.prototype.stopWorker;
  const originalStart = ScanCacheOpened.prototype.unpause;
  const stop = spyOn(ScanCacheOpened.prototype, "stopWorker").mockImplementation(async function (this: ScanCacheOpened) {
    stops++;
    return originalStop.call(this);
  });
  const start = spyOn(ScanCacheOpened.prototype, "unpause").mockImplementation(async function (this: ScanCacheOpened) {
    starts++;
    return originalStart.call(this);
  });
  restore = [() => view.mockRestore(), () => info.mockRestore(), () => setup.mockRestore(), () => create.mockRestore(), () => stop.mockRestore(), () => start.mockRestore()];
});

afterEach(async () => {
  for (const mco of runs) { mco.unwatchConnectionStatus(); await mco.stopWorker(); }
  for (const port of ports.splice(0)) port.close();
  for (const fn of restore) fn();
  addresses.forEach((address, index) => {
    if (keys[index] === undefined) delete Bun.env["vk" + address];
    else Bun.env["vk" + address] = keys[index];
  });
});

async function fixture(name: string) {
  const dir = `${ROOT}/${name}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/ScanSettings.json`, stringify({
    wallets: addresses.map((primary_address) => ({ primary_address })), node_url: "test", start_height: 1,
  }));
  for (const primary_address of addresses) {
    const outputs = Object.fromEntries([7, 8].map((index_on_blockchain) => [String(index_on_blockchain), {
      amount: 5_000_000_000_000n, block_height: 1, index_on_blockchain, tx_hash: `tx-${index_on_blockchain}`,
    } as Output]));
    const block = { block_height: 50, block_timestamp: 1, block_hash: "anchor" };
    const cache: ScanCache = {
      primary_address, outputs, own_key_images: {}, daemon_height: 51,
      scanned_ranges: [{ start: 1, end: 50, block_hashes: [block, block, block] }], tx_logs: [], pending_spent_utxos: {},
    };
    await Bun.write(`${dir}/${primary_address}_cache.json`, stringify(cache));
  }
  const mco = await openWallets({ scan_settings_path: `${dir}/ScanSettings.json`, no_stats: true });
  runs.push(mco);
  await ready.promise;
  stops = starts = 0;
  const selected: number[][] = [];
  for (const wallet of mco.wallets) {
    wallet.calculateFeeAndSelectInputs = async (params) => {
      const selectedInputs = params.inputs ?? wallet.selectInputs(100_000_000_000n, 1n);
      if (!selectedInputs.length) throw new Error("not enough funds");
      return { selectedInputs, feeEstimate: fee };
    };
    wallet.makeTransactionFromSelectedInputs = async (_payments, inputs) => {
      selected.push(inputs.map((output) => output.index_on_blockchain));
      return "unsigned";
    };
    wallet.signTransaction = async () => "signed";
    wallet.sendTransaction = async () => answer();
  }
  return { dir, mco, wallet: mco.wallets[1]!, selected };
}

function send(mco: ManyScanCachesOpened, input_indexes: string[] = []) {
  return mco.makeSignSend({ primary_address: addresses[1]!, payments: [{ address: "dest", amount: "100000000000" }], input_indexes });
}

test("a held non-first-wallet send does not stop or restart scanning", async () => {
  const { dir, mco, wallet } = await fixture("no-pause");
  const entered = gate();
  const release = gate();
  wallet.sendTransaction = async () => { entered.resolve(); await release.promise; return answer(); };
  const pending = send(mco);
  await entered.promise;
  const during = { stops, starts, messages, locks: wallet.cache.pending_spent_utxos };
  release.resolve();
  await pending;
  await Bun.write(`${dir}/result.json`, stringify({ during, after: { stops, starts, messages } }));
  expect(during.stops).toBe(0);
  expect(during.starts).toBe(0);
  expect(stops).toBe(0);
  expect(starts).toBe(0);
  expect(messages).toBe(2);
});

test("another input can be sent while the first node request waits", async () => {
  const { dir, mco, wallet, selected } = await fixture("two-sends");
  const entered = gate();
  const release = gate();
  let calls = 0;
  wallet.sendTransaction = async () => {
    if (calls++ === 0) { entered.resolve(); await release.promise; }
    return answer();
  };
  const first = send(mco);
  await entered.promise;
  await send(mco);
  release.resolve();
  await first;
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  await Bun.write(`${dir}/result.json`, stringify({ selected, logs: cache!.tx_logs, locks: cache!.pending_spent_utxos }));
  expect(selected).toHaveLength(2);
  expect(new Set(selected.flat()).size).toBe(2);
  expect(cache!.tx_logs).toHaveLength(2);
  expect(Object.keys(cache!.pending_spent_utxos!)).toHaveLength(2);
});

test("overlapping explicit spends cannot reserve the same input twice", async () => {
  const { dir, mco, selected } = await fixture("same-input");
  const results = await Promise.allSettled([send(mco, ["7"]), send(mco, ["7"])]);
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  await Bun.write(`${dir}/result.json`, stringify({ results, selected, locks: cache!.pending_spent_utxos }));
  expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  expect(selected).toHaveLength(1);
  expect(cache!.pending_spent_utxos!["7"]).toBeDefined();
});

test("scan result processing keeps a pending send row and its input reservation", async () => {
  const { dir, mco, wallet } = await fixture("scan-during-send");
  const entered = gate();
  const release = gate();
  wallet.sendTransaction = async () => { entered.resolve(); await release.promise; return answer(); };
  const pending = send(mco);
  await entered.promise;
  const block = { block_height: 50, block_timestamp: 1, block_hash: "anchor" };
  blockInput.resolve({ local_uuid: "scan-batch", data: new Uint8Array(), get_blocks_result_meta: { block_infos: [block], daemon_height: 51 } } as GetBlocksBinBufferItem);
  const deadline = Date.now() + 500;
  while (scans < 2 && Date.now() < deadline) await Bun.sleep(1);
  const during = await readCacheFileDefaultLocation(addresses[1]!, dir);
  release.resolve();
  await pending;
  await Bun.write(`${dir}/result.json`, stringify({ scans, locks: during!.pending_spent_utxos, logs: during!.tx_logs }));
  expect(scans).toBe(2);
  expect(during!.tx_logs).toHaveLength(1);
  expect(during!.pending_spent_utxos!["7"]).toBe(0);
});

test("a batch of cache messages keeps every row and returns its own index", async () => {
  const { dir, wallet } = await fixture("message-batch");
  const writer = (wallet as unknown as { cacheWriter: { write: background.WorkerSet["writeCache"] } }).cacheWriter;
  const indices = await Promise.all([1, 2, 3, 4].map((timestamp) => writer.write({
    primary_address: addresses[1], txLog: { timestamp, height: 50, inputs_index: [], payments: [], node_url: "test" },
  })));
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  await Bun.write(`${dir}/result.json`, stringify({ indices, logs: cache!.tx_logs }));
  expect(new Set(indices).size).toBe(4);
  expect(cache!.tx_logs!.map((row) => row.timestamp)).toEqual([1, 2, 3, 4]);
});

test("the direct tool-send path and dismissal use the same coordinator", async () => {
  const { dir, wallet } = await fixture("tool-send");
  const entered = gate();
  const release = gate();
  wallet.sendTransaction = async () => { entered.resolve(); await release.promise; return answer(); };
  const pending = wallet.makeSignSendTransaction({ payments: [{ address: "dest", amount: "100000000000" }], invocationId: "tool-001" });
  await entered.promise;
  await wallet.dismissSendPlate();
  release.resolve();
  await pending;
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(cache!.tx_logs![0]!.hidden_on_send_plate).toBe(true);
  expect(cache!.tx_logs![0]!.invocationId).toBe("tool-001");
  expect(cache!.tx_logs![0]!.sendResult?.status).toBe("OK");
  expect(stops).toBe(0);
  expect(messages).toBe(3);
});

test("a rejected send releases its inputs and rebroadcast reserves them before RPC", async () => {
  const { dir, mco, wallet } = await fixture("rebroadcast");
  wallet.sendTransaction = async () => answer("Failed");
  await expect(send(mco, ["7"])).rejects.toThrow("rpc returned error");
  expect(wallet.cache.pending_spent_utxos!["7"]).toBeUndefined();
  const entered = gate();
  const release = gate();
  wallet.sendTransaction = async () => { entered.resolve(); await release.promise; return answer(); };
  const pending = mco.rebroadcastTx({ primary_address: addresses[1]!, tx_log_index: 0 });
  await entered.promise;
  expect(wallet.cache.pending_spent_utxos!["7"]).toBe(0);
  await expect(send(mco, ["7"])).rejects.toThrow("input not spendable");
  release.resolve();
  await pending;
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(cache!.tx_logs).toHaveLength(1);
  expect(cache!.tx_logs![0]!.sendResult?.status).toBe("OK");
  expect(cache!.tx_logs![0]!.error).toBeUndefined();
  expect(stops).toBe(0);
});

test("sweep reserves its inputs without stopping the scanner", async () => {
  const { dir, mco, wallet } = await fixture("sweep");
  wallet.getFeeEstimate = async () => fee;
  wallet.makeSweepTransactionFromSelectedInputs = async () => "unsigned";
  await mco.sweepSignSend({ primary_address: addresses[1]!, address: "dest", input_indexes: [] });
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(Object.keys(cache!.pending_spent_utxos!)).toEqual(["7", "8"]);
  expect(cache!.tx_logs![0]!.sendResult?.status).toBe("OK");
  expect(stops).toBe(0);
});

test("an older asynchronous stats result cannot replace newer wallet stats", async () => {
  const { wallet } = await fixture("stats-order");
  const entered = gate();
  const release = gate();
  const align = spyOn(stats, "alignScanStatsWithCache").mockImplementation(async (cache) => {
    if (cache.daemon_height === 51) { entered.resolve(); await release.promise; }
    return { total_spendable_amount: BigInt(cache.daemon_height) } as stats.ScanStats;
  });
  restore.push(() => align.mockRestore());
  Reflect.set(wallet, "_no_stats", false);
  const first = wallet.feed({ newCache: { ...wallet.cache, daemon_height: 51 }, changed_outputs: [] });
  await entered.promise;
  await wallet.feed({ newCache: { ...wallet.cache, daemon_height: 52 }, changed_outputs: [] });
  release.resolve();
  await first;
  expect(wallet.cache.daemon_height).toBe(52);
  expect(wallet.amount).toBe(52n);
});

test("a fee request failure is logged without stopping scanning", async () => {
  const { dir, mco, wallet } = await fixture("fee-error");
  wallet.calculateFeeAndSelectInputs = async () => { throw new Error("fee request failed"); };
  await expect(send(mco)).rejects.toThrow("fee request failed");
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(cache!.tx_logs![0]!.error).toContain("fee request failed");
  expect(cache!.tx_logs![0]!.feeEstimate).toBeUndefined();
  expect(cache!.pending_spent_utxos).toEqual({});
  expect(stops).toBe(0);
});

test("a failed request does not stop later cache messages", async () => {
  const { dir, mco, wallet } = await fixture("bad-request");
  const writer = (wallet as unknown as { cacheWriter: { write: background.WorkerSet["writeCache"] } }).cacheWriter;
  await expect(writer.write({ primary_address: addresses[1], txLogIndex: 99, txLog: { error: "bad" } })).rejects.toThrow("tx log missing");
  await send(mco);
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(cache!.tx_logs).toHaveLength(1);
  expect(cache!.tx_logs![0]!.sendResult?.status).toBe("OK");
  expect(stops).toBe(0);
});
