import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { NodeUrl } from "../../../wallet-api/node-interaction/nodeUrl";
import { resetWasmLoaderForTests, setWasmUrls } from "../../../wallet-api/wasm-processing/wasmLoader";
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
  block_header: header,
  blob: "abcd", json: "{\"tx_hashes\":[]}", credits: 0, top_hash: "", status: "OK" as const, untrusted: false,
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

for (const interval_ms of [undefined, 1000]) {
  const interval = interval_ms ?? 5000;
  test(`getInfoDebounced refreshes after ${interval} ms`, async () => {
    const newer = { ...info, height: info.height + 1 };
    const { node, requests } = await setup(`get-info-debounced-${interval}`, [rpc(info), rpc(newer)]);
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    restore = () => clock.mockRestore();
    const read = () => interval_ms === undefined ? node.getInfoDebounced() : node.getInfoDebounced({ interval_ms });

    expect(await read()).toEqual(info);
    clock.mockReturnValue(1000 + interval - 1);
    expect(await read()).toEqual(info);
    expect(requests).toHaveLength(1);
    clock.mockReturnValue(1000 + interval);
    expect(await read()).toEqual(newer);
    expect(await read()).toEqual(newer);
    expect(requests).toHaveLength(2);
  });
}

test("pollTip makes no node call while active() is false", async () => {
  const { node, requests } = await setup("poll-tip-active", [rpc(info), rpc(block)]);
  const controller = new AbortController();
  let rounds = 0;
  const delivered: string[] = [];
  await node.pollTip(({ block_header }) => {
    delivered.push(block_header.hash);
    controller.abort();
  }, controller.signal, 0, undefined, () => ++rounds > 3);
  expect(rounds).toBe(4);
  expect(delivered).toEqual([header.hash]);
  expect(requests.map(request => (request.body as { method: string }).method)).toEqual(["get_info", "get_block"]);
});

test("pollTip caches and delivers each new tip, including a replacement at the same height", async () => {
  const replacement = { ...block, block_header: { ...header, hash: "ab".repeat(32) } };
  const newInfo = { ...info, top_block_hash: replacement.block_header.hash };
  const { node, requests } = await setup("poll-tip", [
    rpc(info), rpc(block), rpc(info),
    rpc(newInfo), rpcError(-1, "node busy"), rpc(newInfo), rpc(replacement),
  ]);
  const controller = new AbortController();
  const delivered: string[] = [];
  const errors: string[] = [];
  await node.pollTip(async ({ block_header }, signal) => {
    delivered.push(block_header.hash);
    expect((await node.getCachedBlock({ height: block_header.height }, signal))?.block_header.hash)
      .toBe(block_header.hash);
    if (delivered.length === 2) controller.abort();
  }, controller.signal, 0, error => {
    errors.push(String(error));
    if (requests.length > 7) controller.abort();
  });

  expect(delivered).toEqual([header.hash, replacement.block_header.hash]);
  expect(errors).toEqual(["Error: RPC error: node busy (code: -1)"]);
  expect(requests.map(request => request.body)).toEqual(
    ["get_info", "get_block", "get_info", "get_info", "get_block", "get_info", "get_block"]
      .map(method => ({ id: "0", jsonrpc: "2.0", method, ...(method === "get_block" && { params: { height: header.height } }) })),
  );
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
  ["invalid-orphan-status", rpc({ ...block, block_header: { ...block.block_header, orphan_status: "false" } })],
  ["invalid-blob", rpc({ ...block, blob: {} })],
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

test("getBlock returns the full validated result and discards unknown fields", async () => {
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
  const empty = { ...block, tx_hashes: undefined };
  const { node } = await setup("empty-block", [rpc(empty), rpc({ ...empty, tx_hashes: [] })]);
  expect(await node.getBlock({ height: 20 })).toEqual(empty);
  expect((await node.getBlock({ height: 20 }))!.tx_hashes).toEqual([]);
});

test("getBlock normalizes accepted hashes for transaction comparisons", async () => {
  const expected = {
    ...block,
    block_header: { ...block.block_header, hash: "ab".repeat(32), prev_hash: "cd".repeat(32) },
    miner_tx_hash: "ef".repeat(32), tx_hashes: ["a1".repeat(32)],
  };
  const upper = {
    ...expected,
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

test("a height hit makes no RPC and a different expected hash refreshes it", async () => {
  const { height } = block.block_header;
  const replacement = { ...block, block_header: { ...block.block_header, hash: "55".repeat(32) } };
  const { node, requests } = await setup("stable-cache", [rpc(block), rpc(replacement)]);

  const first = await node.getCachedBlock({ height });
  expect(first).toEqual(block);
  first!.tx_hashes!.length = 0;
  expect(await node.getCachedBlock({ height })).toEqual(block);
  expect(requests).toHaveLength(1);

  expect(await node.getCachedBlock({ height, expected_hash: replacement.block_header.hash })).toEqual(replacement);
  expect(await node.getCachedBlock({ height })).toEqual(replacement);
  expect(requests.map(request => request.body)).toEqual(Array.from({ length: 2 }, () => ({
    id: "0", jsonrpc: "2.0", method: "get_block", params: { height },
  })));
});

test("a cache miss clears old blocks when the cached parent hash differs", async () => {
  const parent = block.block_header;
  const child = { ...block, block_header: {
    ...parent, height: parent.height + 1, hash: "55".repeat(32), prev_hash: parent.hash,
  } };
  const newBlock = { ...block, block_header: {
    ...parent, height: parent.height + 2, hash: "66".repeat(32), prev_hash: "77".repeat(32),
  } };
  const { node, requests } = await setup("cache-parent-mismatch", [rpc(block), rpc(child), rpc(newBlock), rpc(block)]);

  await node.getCachedBlock({ height: parent.height });
  await node.getCachedBlock({ height: child.block_header.height });
  expect(await node.getCachedBlock({ height: parent.height })).toEqual(block);
  expect(requests).toHaveLength(2);

  expect(await node.getCachedBlock({ height: newBlock.block_header.height })).toEqual(newBlock);
  expect(await node.getCachedBlock({ height: newBlock.block_header.height })).toEqual(newBlock);
  expect(requests).toHaveLength(3);

  expect(await node.getCachedBlock({ height: parent.height })).toEqual(block);
  expect(requests).toHaveLength(4);
});

test("an older response cannot refill the cache after a successor conflict", async () => {
  const { height, hash } = block.block_header;
  const successor = { ...block, block_header: {
    ...block.block_header, height: height + 2, hash: "55".repeat(32), prev_hash: "66".repeat(32),
  } };
  const replacement = { ...block, block_header: { ...block.block_header, hash: "88".repeat(32) } };
  const newParent = { ...block, block_header: {
    ...block.block_header, height: height + 1, hash: "77".repeat(32), prev_hash: replacement.block_header.hash,
  } };
  const newSuccessor = { ...successor, block_header: {
    ...successor.block_header, hash: "99".repeat(32), prev_hash: newParent.block_header.hash,
  } };
  const { node, requests } = await setup("cache-delayed-refill", [
    rpc(successor), rpc(newParent), rpc(replacement), rpc(newSuccessor),
  ]);
  await node.getCachedBlock({ height: height + 2 });
  const delayed = Promise.withResolvers<typeof block>();
  const getBlock = node.getBlock.bind(node);
  const fetch = spyOn(node, "getBlock").mockImplementationOnce(() => delayed.promise).mockImplementation(getBlock);
  restore = () => fetch.mockRestore();

  const pending = node.getCachedBlock({ height });
  expect(await node.getCachedBlock({ height: height + 1 })).toEqual(newParent);
  delayed.resolve(block);
  expect(await pending).toEqual(block);
  expect(await node.getCachedBlock({ height })).toEqual(replacement);
  expect(await node.getCachedBlock({ height: height + 2 })).toEqual(newSuccessor);
  expect(requests).toHaveLength(4);
});

test("cache trimming keeps the most recently requested heights", async () => {
  const hashes = ["aa", "bb", "cc", "dd"].map(byte => byte.repeat(32));
  const reply = (index: number) => rpc({ ...block, block_header: { ...block.block_header, height: index + 20, hash: hashes[index], prev_hash: hashes[index - 1] ?? block.block_header.prev_hash } });
  const { requests } = await setup("cache-trim", [0, 1, 2, 3, 0, 2].map(reply));
  const node = new NodeUrl("https://node.test", { block_cache_limit: 3, block_cache_after_trim: 2 });

  for (const index of [0, 0, 0, 1, 2, 1, 3, 1, 3, 0, 2]) {
    expect((await node.getCachedBlock({ height: index + 20 }))?.block_header.hash).toBe(hashes[index]);
  }
  expect(requests.map(request => (request.body as { params: { height: number } }).params.height))
    .toEqual([20, 21, 22, 23, 20, 22]);
});

test("the node URL is read-only and each instance has its own cache", async () => {
  const { node, requests } = await setup("cache-retry", [rpc({}), rpc(block), rpc(block)]);
  const { height } = block.block_header;
  await expect(node.getCachedBlock({ height })).rejects.toThrow("Failed to parse block");
  expect(await node.getCachedBlock({ height })).toMatchObject({ tx_hashes: block.tx_hashes });
  expect(Reflect.set(node, "node_url", "https://other.test")).toBe(false);
  expect(node.node_url).toBe("https://node.test");
  const other = new NodeUrl("https://other.test");
  expect(await other.getCachedBlock({ height })).toEqual(block);
  expect(await node.getCachedBlock({ height })).toEqual(block);
  expect(await other.getCachedBlock({ height })).toEqual(block);
  expect(requests.map(request => request.url)).toEqual([
    "https://node.test/json_rpc", "https://node.test/json_rpc", "https://other.test/json_rpc",
  ]);
});

test("NodeUrl.create uses the configured block cache limit and trim size", async () => {
  const hashes = ["11", "22", "33"].map(byte => byte.repeat(32));
  const reply = (hash: string) => rpc({ ...block, block_header: { ...block.block_header, height: 20 + hashes.indexOf(hash), hash, prev_hash: hashes[hashes.indexOf(hash) - 1] ?? block.block_header.prev_hash } });
  const { requests } = await setup("custom-cache-size", [
    ...hashes.map(reply), reply(hashes[0]!), reply(hashes[1]!),
  ]);
  setWasmUrls({ monero: "dist/monero_wallet_api.wasm" });
  restore = resetWasmLoaderForTests;
  const node = await NodeUrl.create("https://node.test", { block_cache_limit: 2, block_cache_after_trim: 1 });
  const read = (index: number) => node.getCachedBlock({ height: index + 20 });
  for (const index of [0, 1, 0, 2, 2, 0, 1]) await read(index);
  expect(requests.map(request => (request.body as { params: { height: number } }).params.height))
    .toEqual([20, 21, 22, 20, 21]);
});
