import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { NodeUrl } from "../../../wallet-api/node-interaction/nodeUrl";
import { WasmProcessor } from "../../../wallet-api/wasm-processing/wasmProcessor";

const header = {
  block_size: 0, block_weight: 0, cumulative_difficulty: 1, cumulative_difficulty_top64: 0,
  depth: 0, difficulty: 1, difficulty_top64: 0, hash: "11".repeat(32), height: 20,
  long_term_weight: 0, major_version: 16, miner_tx_hash: "22".repeat(32), minor_version: 0,
  nonce: 0, num_txes: 1, orphan_status: false, pow_hash: "", prev_hash: "33".repeat(32),
  reward: 0, timestamp: 1, wide_cumulative_difficulty: "1", wide_difficulty: "1",
};
const info = {
  adjusted_time: 0, alt_blocks_count: 0, block_size_limit: 0, block_size_median: 0,
  block_weight_limit: 0, block_weight_median: 0, bootstrap_daemon_address: "", busy_syncing: false,
  credits: 0, cumulative_difficulty: 1, cumulative_difficulty_top64: 0, database_size: 0,
  difficulty: 1, difficulty_top64: 0, free_space: 0, grey_peerlist_size: 0, height: 21,
  height_without_bootstrap: 21, incoming_connections_count: 0, mainnet: false, nettype: "fakechain",
  offline: true, outgoing_connections_count: 0, restricted: false, rpc_connections_count: 0,
  stagenet: false, start_time: 0, status: "OK", synchronized: true, target: 120, target_height: 21,
  testnet: false, top_block_hash: header.hash, top_hash: "", tx_count: 1, tx_pool_size: 0,
  untrusted: false, update_available: false, version: "test", was_bootstrap_ever_used: false,
  white_peerlist_size: 0, wide_cumulative_difficulty: "1", wide_difficulty: "1",
};
const headers = { credits: 0, status: "OK", top_hash: "", untrusted: false, headers: [header] };
const block = {
  block_header: { hash: header.hash, prev_hash: header.prev_hash, height: header.height, depth: header.depth },
  miner_tx_hash: header.miner_tx_hash,
  tx_hashes: ["44".repeat(32)],
};
const sent = {
  status: "OK", reason: "", double_spend: false, fee_too_low: false, invalid_input: false,
  invalid_output: false, low_mixin: false, not_relayed: false, overspend: false, too_big: false, untrusted: false,
};
const rpc = (result: unknown) => ({ id: "0", jsonrpc: "2.0", result });
const rpcError = (code: number, message: string) => ({ id: "0", jsonrpc: "2.0", error: { code, message } });
const originalFetch = globalThis.fetch;
let save: (() => Promise<unknown>) | undefined;
let restore: (() => void) | undefined;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  restore?.();
  restore = undefined;
  await save?.();
  save = undefined;
});

async function setup(name: string, responses: unknown[]) {
  const dir = `test-data/node-url-json/${name}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/responses.json`, JSON.stringify(responses, null, 2));
  const signals: (AbortSignal | null | undefined)[] = [];
  const requests: { url: string; method?: string; body: unknown; signal: boolean; aborted: boolean }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)), signal: !!init?.signal, aborted: init?.signal?.aborted ?? false });
    init?.signal?.throwIfAborted();
    if (!responses.length) throw new Error("unexpected request");
    return Response.json(responses.shift());
  }) as unknown as typeof fetch;
  save = () => Bun.write(`${dir}/requests.json`, JSON.stringify(requests, null, 2));
  return { node: new NodeUrl("https://node.test"), requests, signals };
}

test("a NodeUrl constructor uses JSON RPC without initializing WASM and keeps relay defaults", async () => {
  const init = spyOn(WasmProcessor.prototype, "initWasmModule").mockImplementation(() => { throw new Error("JSON RPC must not initialize WASM"); });
  restore = () => init.mockRestore();
  const { node, requests } = await setup("json-only", [rpc(info), rpc(headers), sent, sent]);
  expect(await node.getInfo()).toEqual(info);
  expect(await node.getBlockHeadersRange({ start_height: 20, end_height: 20 })).toEqual(headers);
  expect(await node.sendRawTransaction("0102")).toEqual(sent);
  expect(await node.sendRawTransaction("0304", true)).toEqual(sent);
  expect(requests.map(request => request.url)).toEqual([
    "https://node.test/json_rpc", "https://node.test/json_rpc",
    "https://node.test/send_raw_transaction", "https://node.test/send_raw_transaction",
  ]);
  expect(requests[2]!.body).toEqual({ tx_as_hex: "0102", do_not_relay: false });
  expect(requests[3]!.body).toEqual({ tx_as_hex: "0304", do_not_relay: true });
  expect(init).not.toHaveBeenCalled();
  expect(node.tinywasi).toBeUndefined();
});

test("getBlock accepts a height or hash and preserves missing-block and RPC errors", async () => {
  const { node, requests } = await setup("get-block", [
    rpc(block), rpc(block), rpcError(-2, "height too high"),
    rpcError(-1, "node busy"), rpc({ block_header: { hash: header.hash } }),
  ]);
  expect(await node.getBlock({ height: 20 })).toEqual(block);
  expect(await node.getBlock({ hash: header.hash })).toEqual(block);
  expect(await node.getBlock({ height: 21 })).toBeNull();
  await expect(node.getBlock({ height: 20 })).rejects.toThrow("RPC error: node busy");
  await expect(node.getBlock({ height: 20 })).rejects.toThrow("Failed to parse block");
  expect(requests[0]!.body).toEqual({ id: "0", jsonrpc: "2.0", method: "get_block", params: { height: 20 } });
  expect(requests[1]!.body).toEqual({ id: "0", jsonrpc: "2.0", method: "get_block", params: { hash: header.hash } });
});

const malformed: [string, unknown][] = [
  ["null-envelope", null],
  ["array-envelope", []],
  ["string-envelope", "<script>throw 1</script>"],
  ["missing-result", { id: "0", jsonrpc: "2.0" }],
  ["null-result", rpc(null)],
  ["wrong-version", { ...rpc(block), jsonrpc: "1.0" }],
  ["wrong-id", { ...rpc(block), id: "another-request" }],
  ["both-result-and-error", { ...rpc(block), error: { code: -2, message: "height too high" } }],
  ["bad-error-code", { ...rpcError(-2, "height too high"), error: { code: "-2", message: "bad" } }],
  ["bad-error-message", { ...rpcError(-2, "height too high"), error: { code: -2, message: {} } }],
  ["null-error", { ...rpc(block), error: null }],
  ["missing-header", rpc({ ...block, block_header: undefined })],
  ["null-header", rpc({ ...block, block_header: null })],
  ["missing-miner-hash", rpc({ ...block, miner_tx_hash: undefined })],
  ["invalid-miner-hash", rpc({ ...block, miner_tx_hash: "x".repeat(64) })],
  ["hash-list-is-string", rpc({ ...block, tx_hashes: block.tx_hashes[0] })],
  ["hash-list-is-object", rpc({ ...block, tx_hashes: { includes: true } })],
  ["hash-list-is-null", rpc({ ...block, tx_hashes: null })],
  ["hash-list-has-non-hash", rpc({ ...block, tx_hashes: ["<script>throw 1</script>"] })],
  ["hash-list-has-object", rpc({ ...block, tx_hashes: [{}] })],
  ["failed-status", rpc({ ...block, status: "BUSY" })],
];
for (const field of ["height", "depth"] as const) {
  for (const [label, value] of [["missing", undefined], ["negative", -1], ["fraction", 1.5], ["unsafe", 2 ** 53], ["string", "20"]] as const) {
    malformed.push([`${field}-${label}`, rpc({ ...block, block_header: { ...block.block_header, [field]: value } })]);
  }
}
for (const field of ["hash", "prev_hash"] as const) {
  for (const [label, value] of [["short", "ab"], ["nonhex", "x".repeat(64)], ["object", {}]] as const) {
    malformed.push([`${field}-${label}`, rpc({ ...block, block_header: { ...block.block_header, [field]: value } })]);
  }
}
for (const [name, response] of malformed) {
  test(`getBlock rejects an untrusted ${name}`, async () => {
    const { node } = await setup(`invalid-${name}`, [response]);
    await expect(node.getBlock({ height: 20 })).rejects.toThrow("Failed to parse block");
  });
}

test("getBlock returns only known fields and discards prototype keys", async () => {
  const poison = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extra":"<script>throw 1</script>"}');
  const response = { ...rpc({ ...block, ...poison, block_header: { ...header, ...poison } }), ...poison };
  const { node } = await setup("extra-fields", [response]);
  const parsed = await node.getBlock({ height: 20 });
  expect(parsed).toEqual(block);
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(parsed!.block_header)).toBe(Object.prototype);
  expect(Object.prototype).not.toHaveProperty("polluted");
});

test("getBlock accepts an empty block with no transaction hash list", async () => {
  const empty = { block_header: block.block_header, miner_tx_hash: block.miner_tx_hash };
  const { node } = await setup("empty-block", [rpc(empty), rpc({ ...empty, tx_hashes: [] })]);
  expect(await node.getBlock({ height: 20 })).toEqual(empty);
  expect((await node.getBlock({ height: 20 }))!.tx_hashes).toEqual([]);
});

test("getBlock normalizes accepted hashes for transaction comparisons", async () => {
  const expected = {
    block_header: { ...block.block_header, hash: "ab".repeat(32), prev_hash: "cd".repeat(32) },
    miner_tx_hash: "ef".repeat(32), tx_hashes: ["a1".repeat(32)],
  };
  const upper = {
    block_header: { ...expected.block_header, hash: expected.block_header.hash.toUpperCase(), prev_hash: expected.block_header.prev_hash.toUpperCase() },
    miner_tx_hash: expected.miner_tx_hash.toUpperCase(), tx_hashes: expected.tx_hashes.map(hash => hash.toUpperCase()),
  };
  const { node } = await setup("uppercase-hashes", [rpc(upper)]);
  const parsed = await node.getBlock({ hash: upper.block_header.hash });
  expect(parsed).toEqual(expected);
  expect(parsed!.tx_hashes!.includes(expected.tx_hashes[0]!)).toBe(true);
});

test("getBlock rejects a valid response for a different requested block", async () => {
  const { node } = await setup("wrong-block", [rpc(block), rpc(block)]);
  await expect(node.getBlock({ height: 19 })).rejects.toThrow("does not match");
  await expect(node.getBlock({ hash: "55".repeat(32) })).rejects.toThrow("does not match");
});

test("getBlock does not treat an unknown hash as an above-tip height", async () => {
  const { node } = await setup("hash-error", [rpcError(-2, "invalid hash")]);
  await expect(node.getBlock({ hash: header.hash })).rejects.toThrow("RPC error");
});

for (const [name, response, call] of [
  ["get-info", rpc(info), (node: NodeUrl, signal: AbortSignal) => node.getInfo(signal)],
  ["get-headers", rpc(headers), (node: NodeUrl, signal: AbortSignal) => node.getBlockHeadersRange({ start_height: 20, end_height: 20 }, signal)],
  ["get-block", rpc(block), (node: NodeUrl, signal: AbortSignal) => node.getBlock({ height: 20 }, signal)],
  ["send", sent, (node: NodeUrl, signal: AbortSignal) => node.sendRawTransaction("0102", false, signal)],
] as const) {
  test(`${name} forwards the caller's abort signal through the JSON request`, async () => {
    const { node, signals } = await setup(`abort-${name}`, [response, response]);
    const controller = new AbortController();
    await call(node, controller.signal);
    expect(signals[0]).toBe(controller.signal);
    controller.abort(new Error("tracker stopped"));
    await expect(call(node, controller.signal)).rejects.toThrow("tracker stopped");
    expect(signals[1]).toBe(controller.signal);
  });
}
