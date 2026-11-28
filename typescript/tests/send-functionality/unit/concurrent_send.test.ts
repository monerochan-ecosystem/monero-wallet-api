import { afterEach, beforeEach, expect, spyOn, test, setSystemTime } from "bun:test";
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
  canRebroadcastTx,
  isInputLocked,
} from "../../../dist/xmr3";
import * as coordinator from "../../../dist/xmr3";
import * as background from "../../../dist/xmr3";
import * as blocks from "../../../dist/xmr3";
import * as rpc from "../../../dist/xmr3";
import * as stats from "../../../dist/xmr3";
import { createCoordinatorCommandSender, queueCoordinatorCommand } from "../../../dist/scanning-syncing/scanresult/coordinatorCommand";

const ROOT = resolve("test-data/coordinator-send");
// the command envelope that the outer wallet sends to the coordinator
const STUBBED = ["calculateFeeAndSelectInputs", "makeTransactionFromSelectedInputs", "signTransaction", "sendTransaction", "getFeeEstimate", "makeSweepTransactionFromSelectedInputs"] as const;
type StubName = (typeof STUBBED)[number];
type AnyMethod = (this: ScanCacheOpened, ...args: any[]) => any;
const addresses = ["send-a", "send-b"];
const DAY = 24 * 60 * 60_000;
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
    scanTransaction: ({ tx_as_hex }: { tx_as_hex: string }) => ({ tx_hash: `hash-${tx_as_hex}` }),
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
          // a save of a running command is on disk. its reply lets the command continue.
          messages++;
          event.replyPort.postMessage({ txLogIndex: event.txLogIndex });
          event.replyPort.close();
        } else scans++;
      }
    })();
    const commands = createCoordinatorCommandSender(
      (message, port) => queueCoordinatorCommand(new MessageEvent("message", {
        data: structuredClone(message),
        ports: [port],
      })),
      () => controller.signal.aborted,
    );
    controller.signal.addEventListener("abort", commands.cancelPending, { once: true });
    return {
      fetchWorker: {} as Worker, cpuWorkers: [], dumpHeaps: async () => [],
      shutdown: async () => { controller.abort(); await loop; },
      terminate: () => { controller.abort(); },
      callCoordinator: commands.callCoordinator,
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
  setSystemTime();
  for (const mco of runs) { mco.unwatchConnectionStatus(); await mco.stopWorker(); }
  for (const port of ports.splice(0)) port.close();
  for (const fn of restore) fn();
  addresses.forEach((address, index) => {
    if (keys[index] === undefined) delete Bun.env["vk" + address];
    else Bun.env["vk" + address] = keys[index];
  });
});

async function fixture(name: string, outputIndexes = [7, 8]) {
  const dir = `${ROOT}/${name}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/ScanSettings.json`, stringify({
    wallets: addresses.map((primary_address) => ({ primary_address })), node_url: "test", start_height: 1,
  }));
  for (const primary_address of addresses) {
    const outputs = Object.fromEntries(outputIndexes.map((index_on_blockchain) => [String(index_on_blockchain), {
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
  // each command runs on a fresh instance inside the coordinator. its wallet calls go to the stubs on the outer wallet.
  for (const name of STUBBED) {
    const original = ScanCacheOpened.prototype[name] as AnyMethod;
    const spy = spyOn(ScanCacheOpened.prototype as unknown as Record<StubName, AnyMethod>, name).mockImplementation(function (this: ScanCacheOpened, ...args: any[]) {
      const outer = mco.wallets.find((row) => row.primary_address === this.primary_address) ?? this;
      if (outer === this || !Object.hasOwn(outer, name)) return original.call(this, ...args);
      return (outer as unknown as Record<StubName, AnyMethod>)[name](...args);
    });
    restore.push(() => spy.mockRestore());
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
  expect(during.messages).toBe(3);
  expect(stops).toBe(0);
  expect(starts).toBe(0);
  // reserve, signed bytes, broadcast timestamp, and result all use the coordinator.
  expect(messages).toBe(4);
});

test("signed transaction reaches disk before the node request", async () => {
  const { dir, mco, wallet } = await fixture("signed-before-node");
  let observed: any = null;
  let writesAtNode = 0;
  wallet.sendTransaction = async () => { observed = await readCacheFileDefaultLocation(addresses[1]!, dir); writesAtNode = messages; return answer(); };
  const metadata = { checkout: { reference: "invoice-41", amount: "12.50" } };
  const signed = await wallet.makeSignTransaction({ payments: [{ address: "dest", amount: "100000000000" }], invocationId: "handover", metadata });
  const before = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(before?.tx_logs?.[0]?.signed_tx).toBe("signed");
  expect(before?.tx_logs?.[0]?.sendResult).toBeUndefined();
  await wallet.sendSignedTransaction(signed, "handover");
  await Bun.write(`${dir}/result.json`, stringify({ writesAtNode, observed }));
  expect(before?.tx_logs?.[0]?.metadata).toEqual(metadata);
  expect(writesAtNode).toBe(3);
  expect(observed?.tx_logs?.[0]?.signed_tx).toBe("signed");
  expect(observed?.tx_logs?.[0]?.sendResult).toBeUndefined();
  expect(observed?.tx_logs?.[0]?.metadata).toEqual(metadata);
});

test("a caller can act between signing and sending without stopping the coordinator", async () => {
  const { dir, wallet } = await fixture("signed-handover-order");
  const entered = gate();
  const release = gate();
  const order: string[] = [];
  wallet.signTransaction = async () => { order.push("signed"); return "signed"; };
  wallet.sendTransaction = async () => { order.push("payer node"); entered.resolve(); await release.promise; return answer(); };
  const signed = await wallet.makeSignTransaction({ payments: [{ address: "dest", amount: "100000000000" }], invocationId: "signed-handover-order" });
  const pending = wallet.sendSignedTransaction(signed, "signed-handover-order", () => {
    order.push("handover started");
  });
  try {
    await entered.promise;
    const during = await readCacheFileDefaultLocation(addresses[1]!, dir);
    await Bun.write(`${dir}/result.json`, stringify({ order, during, stops, starts, messages }));
    expect(order).toEqual(["signed", "handover started", "payer node"]);
    expect(during!.tx_logs).toHaveLength(1);
    expect(during!.tx_logs![0]!.signed_tx).toBe("signed");
    expect(during!.tx_logs![0]!.last_broadcast_at).toBeNumber();
    expect(during!.tx_logs![0]!.sendResult).toBeUndefined();
    expect(during!.pending_spent_utxos!["7"]).toBe(0);
    expect(stops).toBe(0);
    expect(starts).toBe(0);
    // reserve, signed, and broadcast writes are done. the result waits for the node.
    expect(messages).toBe(3);
  } finally { release.resolve(); await pending; }
});

test("sending a signed result rejects a wrong wallet, changed bytes, or wrong invocation before any RPC", async () => {
  const { mco, wallet } = await fixture("signed-row-ownership");
  let requests = 0;
  for (const current of mco.wallets) current.sendTransaction = async () => { requests++; return answer(); };
  const signed = await wallet.makeSignTransaction({ payments: [{ address: "dest", amount: "100000000000" }], invocationId: "owner" });
  await expect(mco.wallets[0]!.sendSignedTransaction(signed, "owner")).rejects.toThrow("signed transaction does not match");
  await expect(wallet.sendSignedTransaction({ ...signed, signedTx: "other" }, "owner")).rejects.toThrow("signed transaction does not match");
  await expect(wallet.sendSignedTransaction(signed, "other-invocation")).rejects.toThrow("signed transaction does not match");
  expect(requests).toBe(0);
});

test("a failed payer broadcast remains locked until manual release through the coordinator", async () => {
  const { dir, mco, wallet } = await fixture("failed-window");
  const now = Date.now();
  setSystemTime(now);
  wallet.sendTransaction = async () => { throw new Error("payer node offline"); };
  await expect(send(mco, ["7"])).rejects.toThrow("payer node offline");
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  await Bun.write(`${dir}/result.json`, stringify(cache));
  expect(cache!.tx_logs![0]!.last_broadcast_at).toBe(now);
  expect(cache!.tx_logs![0]!.error).toContain("payer node offline");
  expect(wallet.failed_txs).toHaveLength(1);
  expect(isInputLocked(wallet.cache, "7")).toBe(true);
  await expect(send(mco, ["7"])).rejects.toThrow("input not spendable");
  setSystemTime(now + DAY);
  expect(wallet.spendableInputs().some((input) => input.index_on_blockchain === 7)).toBe(false);
  await expect(send(mco, ["7"])).rejects.toThrow("input not spendable");
  await mco.releaseInputs({ primary_address: addresses[1]!, tx_log_index: 0 });
  expect(wallet.spendableInputs().some((input) => input.index_on_blockchain === 7)).toBe(true);
  wallet.sendTransaction = async () => answer();
  await send(mco, ["7"]);
  expect(wallet.cache.pending_spent_utxos!["7"]).toBe(1);
});

test("001 merchant acceptance completes the tool and prevents reuse after payer failure", async () => {
  const { dir, mco, wallet } = await fixture("001-payer-failure");
  wallet.sendTransaction = async () => { throw new Error("payer node offline"); };
  const input = coordinator.parseToolInvocation(`https://merchant.test/pay#monerochan001_amount_0.1_address_${"4".repeat(95)}`, "", { href: "https://merchant.test/checkout", hostname: "merchant.test" } as Location)!;
  input.valid = "valid";
  Object.assign(input.tool.payload, { successUrl: "https://merchant.test/return", handoverUrl: "https://merchant.test/handover" });
  await mco.actionLogOpened.toolCall(input);
  const listeners = new Set<(message: unknown) => void>();
  let received = "";
  const port = { name: input.invocation_id, sender: { url: "https://merchant.test/checkout", tab: { id: 1 }, frameId: 0 },
    onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
    onDisconnect: { addListener() {}, removeListener() {} }, disconnect() {},
    postMessage(message: any) { received = message.payload.tx_as_hex; queueMicrotask(() => { for (const fn of listeners) fn({ ok: true, tx_hash: "hash" }); }); },
  };
  await coordinator.tools["001"].worker.execute_run!({ log: mco.actionLogOpened, getWallets: () => mco, getPort: () => port }, input.invocation_id, { wallet_to_send_from_pa: addresses[1] });
  const result = (await mco.actionLogOpened.invocation(input.invocation_id))!.events.at(-1)!;
  expect(result).toMatchObject({ ok: true, error: "payer node offline", handover: { ok: true } });
  expect(received).toBe("signed");
  expect(wallet.failed_txs).toHaveLength(0);
  expect(isInputLocked(wallet.cache, "7")).toBe(true);
  const saved = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(saved!.tx_logs![0]!.error).toContain("payer node offline");
  expect(saved!.tx_logs![0]!.last_broadcast_at).toBeNumber();
  await Bun.write(`${dir}/result.json`, stringify({ result, cache: saved }));
});

test("reset and dismiss keep locked failures available until manual release", async () => {
  const { dir, mco, wallet } = await fixture("dismiss-one-failure");
  const primary_address = addresses[1]!;
  wallet.sendTransaction = async () => { throw new Error("timeout"); };
  await expect(send(mco, ["7"])).rejects.toThrow("timeout");
  await expect(send(mco, ["8"])).rejects.toThrow("timeout");
  const before = messages;

  await mco.dismissSendPlate({ primary_address, tx_log_index: 0 });
  expect(messages).toBe(before + 1);
  const saved = (await readCacheFileDefaultLocation(primary_address, dir))!;
  expect(saved.tx_logs![0]!.hidden_on_send_plate).toBe(true);
  expect(saved.tx_logs![1]!.hidden_on_send_plate).not.toBe(true);
  await wallet.feed({ newCache: saved, changed_outputs: [] });
  expect(wallet.failed_txs.map((row) => row.index)).toEqual([0, 1]);

  await mco.dismissSendPlate({ primary_address });
  expect(wallet.failed_txs.map((row) => row.index)).toEqual([0, 1]);
  expect(isInputLocked(wallet.cache, "7")).toBe(true);
  expect(isInputLocked(wallet.cache, "8")).toBe(true);

  await mco.releaseInputs({ primary_address, tx_log_index: 0 });
  expect(wallet.failed_txs.map((row) => row.index)).toEqual([1]);
  expect(isInputLocked(wallet.cache, "7")).toBe(false);
  expect(isInputLocked(wallet.cache, "8")).toBe(true);
});

test("release and retry renewal persist a signed draft through the coordinator", async () => {
  const { dir, mco, wallet } = await fixture("signed-draft-release");
  const { signedTx, txLogIndex } = await wallet.makeSignTransaction({
    payments: [{ address: "dest", amount: "100000000000" }],
    inputs: [wallet.cache.outputs["7"]!],
  });
  const before = messages;
  await mco.releaseInputs({ primary_address: addresses[1]!, tx_log_index: txLogIndex });
  expect(messages).toBe(before + 1);
  expect(isInputLocked(wallet.cache, "7")).toBe(false);
  const released = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(released?.pending_spent_utxos).toEqual({});
  expect(released?.tx_logs?.[txLogIndex]).toMatchObject({
    signed_tx: signedTx, last_broadcast_at: null, inputs_unlocked: true,
  });
  await wallet.renewTransactionLock(txLogIndex);
  expect(messages).toBe(before + 2);
  expect(isInputLocked(wallet.cache, "7")).toBe(true);
  expect((await readCacheFileDefaultLocation(addresses[1]!, dir))?.tx_logs?.[txLogIndex]?.inputs_unlocked).toBe(false);
});

test("rebroadcast uses the accepted row's bytes and stops once its input is spent", async () => {
  const { dir, wallet, mco } = await fixture("mined-handover");
  await send(mco, ["7"]);
  const node = spyOn(wallet, "sendTransaction").mockResolvedValue(answer());
  try {
    expect(canRebroadcastTx(wallet.cache, 0)).toBe(true);
    await expect(wallet.rebroadcastTx(0)).resolves.toMatchObject({ status: "OK" });
    expect(node).toHaveBeenCalledWith("signed");
  } finally { node.mockRestore(); }
  // the coordinator learns a spent input only from its own scan. a reopen reads it from disk.
  await mco.stopWorker();
  const mined = structuredClone(wallet.cache);
  mined.outputs["7"]!.spent_in_tx_hash = "hash-signed";
  await Bun.write(`${dir}/${wallet.primary_address}_cache.json`, stringify(mined));
  ready = gate();
  const reopened = await openWallets({ scan_settings_path: `${dir}/ScanSettings.json`, no_stats: true });
  runs.push(reopened);
  await ready.promise;
  const rescanned = reopened.wallets[1]!;
  const again = spyOn(rescanned, "sendTransaction").mockResolvedValue(answer());
  again.mockClear();
  try {
    expect(canRebroadcastTx(rescanned.cache, 0)).toBe(false);
    const before = messages;
    await expect(rescanned.renewTransactionLock(0)).resolves.toBeUndefined();
    // the write decides. it changes nothing for inputs that this transaction spent.
    expect(messages).toBe(before + 1);
    await expect(rescanned.rebroadcastTx(0)).rejects.toThrow("inputs already spent");
    expect(again).not.toHaveBeenCalled();
  } finally { again.mockRestore(); }
});

test("time leaves balances unchanged and manual release updates them without a scan", async () => {
  const { mco, wallet } = await fixture("failed-send-balance");
  const now = Date.now(); setSystemTime(now);
  wallet.sendTransaction = async () => { throw new Error("timeout"); };
  await expect(send(mco, ["7"])).rejects.toThrow("timeout");
  wallet.view_pair.makeSubaddress = () => "sub";
  Reflect.set(wallet, "_no_stats", false);
  await wallet.feed({ newCache: wallet.cache, changed_outputs: [] });
  const before = messages;
  expect(wallet.amount).toBe(5_000_000_000_000n);
  expect(wallet.pending_amount).toBe(5_000_000_000_000n);
  setSystemTime(now + DAY);
  expect(wallet.amount).toBe(5_000_000_000_000n);
  expect(wallet.pending_amount).toBe(5_000_000_000_000n);
  expect(messages).toBe(before);
  await mco.releaseInputs({ primary_address: addresses[1]!, tx_log_index: 0 });
  expect(wallet.amount).toBe(10_000_000_000_000n);
  expect(wallet.pending_amount).toBe(0n);
  expect(messages).toBe(before + 1);
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

test("concurrent draft commands keep every row and return its own index", async () => {
  const { dir, wallet } = await fixture("draft-batch");
  const payments = [{ address: "dest", amount: "100000000000" }];
  const drafts = await Promise.all(["7", "8"].map((id) =>
    wallet.makeSignTransaction({ payments, inputs: [wallet.cache.outputs[id]!] })));
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  await Bun.write(`${dir}/result.json`, stringify({ drafts, logs: cache!.tx_logs }));
  expect(new Set(drafts.map((draft) => draft.txLogIndex)).size).toBe(2);
  expect(cache!.tx_logs!.map((row) => row.signed_tx)).toEqual(["signed", "signed"]);
  expect(cache!.tx_logs!.flatMap((row) => row.inputs_index).sort()).toEqual(["7", "8"]);
});

test("the direct tool-send path and dismissal use the same coordinator", async () => {
  const { dir, wallet } = await fixture("tool-send");
  const entered = gate();
  const release = gate();
  wallet.sendTransaction = async () => { entered.resolve(); await release.promise; return answer(); };
  const pending = wallet.makeSignSendTransaction({ payments: [{ address: "dest", amount: "100000000000" }], invocationId: "tool-001" });
  await entered.promise;
  const during = await readCacheFileDefaultLocation(addresses[1]!, dir);
  await wallet.dismissSendPlate();
  release.resolve();
  const sent = await pending;
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(during!.tx_logs).toHaveLength(1);
  expect(during!.tx_logs![0]!.invocationId).toBe("tool-001");
  expect(during!.tx_logs![0]!.sendResult).toBeUndefined();
  expect(during!.pending_spent_utxos!["7"]).toBe(0);
  expect(sent.status).toBe("OK");
  expect(cache!.tx_logs).toHaveLength(1);
  expect(cache!.tx_logs![0]!.hidden_on_send_plate).toBe(true);
  expect(cache!.tx_logs![0]!.invocationId).toBe("tool-001");
  expect(cache!.tx_logs![0]!.sendResult?.status).toBe("OK");
  expect(cache!.tx_logs![0]!.signed_tx).toBe("signed");
  expect(cache!.pending_spent_utxos!["7"]).toBe(0);
  expect(stops).toBe(0);
  expect(messages).toBe(5);
});

test("same-byte rebroadcast reserves manually released inputs again before RPC", async () => {
  const { dir, mco, wallet } = await fixture("rebroadcast");
  wallet.sendTransaction = async () => answer("Failed");
  await expect(send(mco, ["7"])).rejects.toThrow("rpc returned error");
  expect(isInputLocked(wallet.cache, "7")).toBe(true);
  const firstAttempt = wallet.tx_logs[0]!.last_broadcast_at!;
  setSystemTime(firstAttempt + DAY);
  await mco.releaseInputs({ primary_address: addresses[1]!, tx_log_index: 0 });
  expect(isInputLocked(wallet.cache, "7")).toBe(false);
  const entered = gate();
  const release = gate();
  const bytes = wallet.tx_logs[0]!.signed_tx;
  wallet.sendTransaction = async (signed) => {
    expect(signed).toBe(bytes);
    entered.resolve();
    await release.promise;
    return answer();
  };
  const pending = mco.rebroadcastTx({ primary_address: addresses[1]!, tx_log_index: 0 });
  await entered.promise;
  expect(wallet.cache.pending_spent_utxos!["7"]).toBe(0);
  expect(wallet.tx_logs[0]!.last_broadcast_at).toBe(firstAttempt + DAY);
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

test("a sweep keeps application metadata through a failed broadcast, reopen, and retry", async () => {
  const { dir, mco, wallet } = await fixture("sweep-metadata");
  const primary_address = wallet.primary_address;
  const readSavedRows = async () => (await readCacheFileDefaultLocation(primary_address, dir))!.tx_logs!;
  wallet.sendTransaction = async () => answer("Failed");
  await expect(send(mco, ["7"])).rejects.toThrow("rpc returned error");
  await mco.releaseInputs({ primary_address, tx_log_index: 0 });
  const [original] = await readSavedRows();

  const metadata = { checkout: { amount: "25.50", fields: [{ amount: 7 }, { amount: false }, null] }, source: "client-42" };
  let beforeBroadcast: ScanCache["tx_logs"];
  wallet.getFeeEstimate = async () => fee;
  wallet.makeSweepTransactionFromSelectedInputs = async () => "unsigned";
  wallet.signTransaction = async () => "signed-sweep";
  wallet.sendTransaction = async () => {
    beforeBroadcast = await readSavedRows();
    return answer("Failed");
  };
  await expect(mco.sweepSignSend({ primary_address, address: "dest", input_indexes: ["7"], metadata })).rejects.toThrow("rpc returned error");
  const afterFailure = await readSavedRows();

  await mco.stopWorker();
  ready = gate();
  const reopened = await openWallets({ scan_settings_path: `${dir}/ScanSettings.json`, no_stats: true });
  runs.push(reopened);
  await ready.promise;
  const afterReopen = structuredClone(reopened.wallets[1]!.tx_logs);
  wallet.sendTransaction = async () => answer();
  await reopened.rebroadcastTx({ primary_address, tx_log_index: 1 });
  const afterRetry = await readSavedRows();
  await Bun.write(`${dir}/result.json`, stringify({ original, beforeBroadcast, afterFailure, afterReopen, afterRetry }));

  expect(original?.metadata).toBeUndefined();
  for (const rows of [beforeBroadcast, afterFailure, afterReopen, afterRetry]) {
    expect(rows).toHaveLength(2);
    expect(rows?.[0]).toEqual(original);
    expect(rows?.[1]?.metadata).toEqual(metadata);
    expect(rows?.[1]?.signed_tx).toBe("signed-sweep");
  }
  expect(beforeBroadcast?.[1]?.sendResult).toBeUndefined();
  expect(afterFailure[1]?.sendResult?.status).toBe("Failed");
  expect(afterReopen[1]).toEqual(afterFailure[1]);
  expect(afterRetry[1]?.sendResult?.status).toBe("OK");
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
  const metadata = { request: { amount: null } };
  wallet.calculateFeeAndSelectInputs = async () => { throw new Error("fee request failed"); };
  await expect(mco.makeSignSend({
    primary_address: wallet.primary_address,
    payments: [{ address: "dest", amount: "100000000000" }],
    input_indexes: [],
    metadata,
  })).rejects.toThrow("fee request failed");
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(cache!.tx_logs![0]!.error).toContain("fee request failed");
  expect(cache!.tx_logs![0]!.metadata).toEqual(metadata);
  expect(cache!.tx_logs![0]!.feeEstimate).toBeUndefined();
  expect(cache!.pending_spent_utxos).toEqual({});
  expect(stops).toBe(0);
});

test("a rejected command does not stop later commands", async () => {
  const { dir, mco } = await fixture("bad-request");
  await expect(mco.releaseInputs({ primary_address: addresses[1], tx_log_index: 99 })).rejects.toThrow("tx log missing");
  await send(mco);
  const cache = await readCacheFileDefaultLocation(addresses[1]!, dir);
  expect(cache!.tx_logs).toHaveLength(1);
  expect(cache!.tx_logs![0]!.sendResult?.status).toBe("OK");
  expect(stops).toBe(0);
});

test("payer acceptance survives a failed outcome write through the coordinator", async () => {
  const { dir, wallet } = await fixture("accepted-outcome-write-error");
  const signed = await wallet.makeSignTransaction({
    payments: [{ address: "dest", amount: "100000000000" }], invocationId: "accepted",
  });
  const originalWrite = coordinator.writeCacheToFile;
  const failFinalWrite = spyOn(coordinator, "writeCacheToFile").mockImplementation(async (cache, path) => {
    if (cache.tx_logs?.some(row => row.sendResult?.status === "OK")) throw new Error("outcome write failed");
    return originalWrite(cache, path);
  });
  try {
    expect(await wallet.sendSignedTransaction(signed, "accepted")).toMatchObject({
      status: "OK", cache_error: "outcome write failed",
    });
    const saved = await readCacheFileDefaultLocation(addresses[1]!, dir);
    expect(saved?.tx_logs?.[0]?.signed_tx).toBe(signed.signedTx);
    expect(saved?.tx_logs?.[0]?.last_broadcast_at).toBeNumber();
    expect(saved?.tx_logs?.[0]?.sendResult).toBeUndefined();
  } finally { failFinalWrite.mockRestore(); }
});

test("a failed broadcast checkpoint prevents both external calls", async () => {
  const { dir, wallet } = await fixture("broadcast-checkpoint-write-error");
  const signed = await wallet.makeSignTransaction({
    payments: [{ address: "dest", amount: "100000000000" }],
  });
  const path = `${dir}/${wallet.primary_address}_cache.json`;
  const draft = await Bun.file(path).text();
  await rm(path);
  await mkdir(path);
  const node = spyOn(wallet, "sendTransaction");
  let handoverCalls = 0;
  try {
    await expect(wallet.sendSignedTransaction(signed, undefined, () => { handoverCalls++; })).rejects.toThrow();
    expect(handoverCalls).toBe(0);
    expect(node).not.toHaveBeenCalled();
    expect(wallet.tx_logs[signed.txLogIndex]?.last_broadcast_at).toBeNull();
  } finally {
    await rm(path, { recursive: true });
    await Bun.write(path, draft);
    node.mockRestore();
  }
});

test("a successful send keeps its input locked after a reopen", async () => {
  const { dir, mco, wallet } = await fixture("ok-send-reopen", [7]);
  await send(mco, ["7"]);
  // coordinator instances call the stubs of this outer wallet, also after the reopen
  let nodeCalls = 0;
  wallet.sendTransaction = async () => { nodeCalls++; return answer(); };
  await mco.stopWorker();
  ready = gate();
  const reopened = await openWallets({ scan_settings_path: `${dir}/ScanSettings.json`, no_stats: true });
  runs.push(reopened);
  await ready.promise;
  const saved = await readCacheFileDefaultLocation(wallet.primary_address, dir);
  await Bun.write(`${dir}/result.json`, stringify({ tx_logs: saved?.tx_logs, pending_spent_utxos: saved?.pending_spent_utxos }));
  expect(saved?.tx_logs?.[0]?.sendResult?.status).toBe("OK");
  const reopenedWallet = reopened.wallets[1]!;
  expect(isInputLocked(reopenedWallet.cache, "7")).toBe(true);
  expect(reopenedWallet.spendableInputs()).toEqual([]);
  wallet.calculateFeeAndSelectInputs = async () => {
    const selectedInputs = reopenedWallet.selectInputs(100_000_000_000n, 1n);
    if (!selectedInputs.length) throw new Error("not enough funds");
    return { selectedInputs, feeEstimate: fee };
  };
  await expect(send(reopened, ["7"])).rejects.toThrow("input not spendable");
  await expect(send(reopened)).rejects.toThrow("not enough funds");
  expect(nodeCalls).toBe(0);
});

test("a wallet without a worker cannot write its tx log", async () => {
  const { dir } = await fixture("no-worker-read-only");
  const readOnly = await openWallets({ scan_settings_path: `${dir}/ScanSettings.json`, no_worker: true, no_stats: true });
  runs.push(readOnly);
  await expect(readOnly.wallets[1]!.releaseInputs(0)).rejects.toThrow("require the coordinator");
});

test("reopening wallets recovers signed drafts and attempts from disk", async () => {
  const { dir, mco, wallet } = await fixture("reopen-signed-sends");
  const payments = [{ address: "dest", amount: "100000000000" }];
  const draft = await wallet.makeSignTransaction({ payments, inputs: [wallet.cache.outputs["7"]!] });
  const attempted = await wallet.makeSignTransaction({ payments, inputs: [wallet.cache.outputs["8"]!] });
  await wallet.renewTransactionLock(attempted.txLogIndex);
  await mco.stopWorker();

  ready = gate();
  const reopened = await openWallets({ scan_settings_path: `${dir}/ScanSettings.json`, no_stats: true });
  runs.push(reopened);
  await ready.promise;
  const saved = await readCacheFileDefaultLocation(wallet.primary_address, dir);
  expect(saved?.tx_logs).toEqual(reopened.wallets[1]?.tx_logs);
  expect(saved?.tx_logs?.[draft.txLogIndex]).toMatchObject({
    signed_tx: draft.signedTx, last_broadcast_at: null, error: "send interrupted before broadcast",
  });
  expect(saved?.tx_logs?.[attempted.txLogIndex]).toMatchObject({
    signed_tx: attempted.signedTx, error: "send interrupted before broadcast result",
  });
  expect(isInputLocked(saved!, "7")).toBe(true);
  expect(isInputLocked(saved!, "8")).toBe(true);
  const recovered = reopened.wallets[1]!;
  const node = spyOn(recovered, "sendTransaction").mockResolvedValue(answer());
  try {
    await recovered.rebroadcastTx(draft.txLogIndex);
    expect(node).toHaveBeenCalledWith(draft.signedTx);
    await recovered.releaseInputs(attempted.txLogIndex);
    const updated = await readCacheFileDefaultLocation(wallet.primary_address, dir);
    expect(isInputLocked(updated!, "7")).toBe(true);
    expect(isInputLocked(updated!, "8")).toBe(false);
  } finally {
    node.mockRestore();
  }
});

// a lost merchant reply, then a retry while the scan marks the inputs spent.
// the mark comes right after the coordinator read the inputs and queued its renewal.
async function retryWhileScanMarksSpent(name: string, spentBy: string) {
  const { dir, mco, wallet } = await fixture(name);
  const input = coordinator.parseToolInvocation(`https://merchant.test/pay#monerochan001_amount_0.1_address_${"4".repeat(95)}`, "", { href: "https://merchant.test/checkout", hostname: "merchant.test" } as Location)!;
  input.valid = "valid";
  Object.assign(input.tool.payload, { successUrl: "https://merchant.test/return", handoverUrl: "https://merchant.test/handover" });
  await mco.actionLogOpened.toolCall(input);
  const listeners = new Set<(message: unknown) => void>();
  const received: string[] = [];
  let merchant: { ok: boolean; error?: string; tx_hash?: string } = { ok: false, error: "test lost reply" };
  const port = { name: input.invocation_id, sender: { url: "https://merchant.test/checkout", tab: { id: 1 }, frameId: 0 },
    onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
    onDisconnect: { addListener() {}, removeListener() {} }, disconnect() {},
    postMessage(message: any) { received.push(message.payload.tx_as_hex); const reply = merchant; queueMicrotask(() => { for (const fn of listeners) fn(reply); }); },
  };
  const ctx = { log: mco.actionLogOpened, getWallets: () => mco, getPort: () => port };
  await coordinator.tools["001"].worker.execute_run!(ctx, input.invocation_id, { wallet_to_send_from_pa: addresses[1] });
  expect((await mco.actionLogOpened.invocation(input.invocation_id))!.events.at(-1)).toMatchObject({ ok: false, sent: true });
  const renew = ScanCacheOpened.prototype.renewTransactionLock as AnyMethod;
  const spy = spyOn(ScanCacheOpened.prototype, "renewTransactionLock").mockImplementation(function (this: ScanCacheOpened, ...args: any[]) {
    const pending = renew.apply(this, args);
    // the coordinator copy shares its outputs with the scan loop. detectOwnspends sets this mark in place.
    if (!mco.wallets.includes(this)) for (const id of this.tx_logs[args[0]]!.inputs_index) this.cache.outputs[id]!.spent_in_tx_hash = spentBy;
    return pending;
  });
  restore.push(() => spy.mockRestore());
  merchant = { ok: true, tx_hash: "hash-signed" };
  await coordinator.tools["001"].worker.execute_run!(ctx, input.invocation_id, { retryHandover: true });
  const events = (await mco.actionLogOpened.invocation(input.invocation_id))!.events;
  await Bun.write(`${dir}/result.json`, stringify({ events, received, cache: await readCacheFileDefaultLocation(addresses[1]!, dir) }));
  return { events, received, wallet };
}

test("a handover retry delivers the same bytes when the scan marks them mined between the renewal read and its write", async () => {
  const { events, received, wallet } = await retryWhileScanMarksSpent("retry-mined-between", "hash-signed");
  expect(events.at(-1)).toMatchObject({ type: "execute_result", ok: true, sent: true, handover: { ok: true, tx_hash: "hash-signed" } });
  expect(received).toEqual(["signed", "signed"]);
  expect(wallet.tx_logs).toHaveLength(1);
});

test("a handover retry does not deliver bytes whose inputs another transaction spent", async () => {
  const { events, received } = await retryWhileScanMarksSpent("retry-spent-by-other", "other");
  expect(events.at(-1)).toMatchObject({ type: "execute_result", ok: false, sent: true, handover: { ok: false } });
  expect(String((events.at(-1) as { handover?: { error?: string } }).handover?.error)).toContain("input not spendable");
  expect(received).toEqual(["signed"]);
});
