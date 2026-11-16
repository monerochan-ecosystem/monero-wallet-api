import { expect, mock, test } from "bun:test";
import { scanTransaction as scan, ViewPair } from "../../../dist/xmr3";

const fixture = await Bun.file("tests/tools/unit/scan-fixture.json").json();

test("a signed transaction is scanned without opening a wallet", async () => {
  const result = await scan({ tx_as_hex: fixture.tx_as_hex, primary_address: fixture.primary_address, view_key: fixture.secret_view_key });
  expect(result.tx_hash).toBe(fixture.expected.tx_hash);
  expect(result.outputs.some((output) => output.amount === fixture.expected.amount && output.payment_id === fixture.expected.payment_id)).toBe(true);
});

test("a mismatched view key does not scan a transaction", async () => {
  await expect(scan({ tx_as_hex: fixture.tx_as_hex, primary_address: fixture.primary_address, view_key: "01".repeat(32) })).rejects.toThrow();
});

test("one ViewPair scans again after a malformed transaction", async () => {
  const view = await ViewPair.create(fixture.primary_address, fixture.secret_view_key);
  const first = view.scanTransaction(fixture.tx_as_hex);
  expect(() => view.scanTransaction("00")).toThrow("invalid transaction");
  expect(view.scanTransaction(fixture.tx_as_hex)).toEqual(first);
});

test("a hex string as long as the largest valid transaction reaches the parser", async () => {
  const view = await ViewPair.create(fixture.primary_address, fixture.secret_view_key);
  // 149,400 bytes is the largest valid transaction since hard fork v8.
  expect(() => view.scanTransaction("00".repeat(149_400))).toThrow("invalid transaction:");
});

test("register accepts the primary address and the first subaddress of another account", async () => {
  const view = await ViewPair.create(fixture.primary_address, fixture.secret_view_key);
  const first = view.scanTransaction(fixture.tx_as_hex);
  expect(() => view.registerScanSubaddresses([[0, 0], [1, 0]])).not.toThrow();
  expect(view.scanTransaction(fixture.tx_as_hex)).toEqual(first);
});

for (const minor of [0.5, -1, NaN, 0x100000000]) {
  test(`makeSubaddress rejects ${minor} before calling WASM`, () => {
    const makeSubaddress = mock(() => {});
    const view = Object.assign(Object.create(ViewPair.prototype), {
      tinywasi: { instance: { exports: { make_subaddress: makeSubaddress } } },
    }) as ViewPair;
    expect(() => view.makeSubaddress(minor)).toThrow("subaddress indices must");
    expect(makeSubaddress).not.toHaveBeenCalled();
  });
}

test("direct WASM returns the primary address for [0, 0]", async () => {
  const view = await ViewPair.create(fixture.primary_address, fixture.secret_view_key);
  let output: string | undefined;
  let error: { error: string } | undefined;
  view.readFromWasmMemory = (ptr, len) => { output = view.readString(ptr, len); };
  view.readErrorFromWasmMemory = (ptr, len) => {
    error = JSON.parse(view.readString(ptr, len));
  };
  const makeSubaddress = view.tinywasi.instance!.exports.make_subaddress as CallableFunction;
  expect(() => makeSubaddress(0, 0)).not.toThrow();
  expect(output).toBe(fixture.primary_address);
  expect(error).toBeUndefined();
});

test("makeSubaddress returns the primary address for zero and a subaddress for other indices", async () => {
  const view = await ViewPair.create(fixture.primary_address, fixture.secret_view_key);
  expect(view.makeSubaddress(0)).toBe(fixture.primary_address);
  const subaddress = view.makeSubaddress(1);
  expect(subaddress).toHaveLength(95);
  expect(subaddress).not.toBe(fixture.primary_address);
  expect(view.makeSubaddress(0xffffffff)).toHaveLength(95);
});

test("zero returns the primary address when ViewPair was given an integrated address", async () => {
  const view = await ViewPair.create(fixture.primary_address, fixture.secret_view_key);
  const integrated = view.makeIntegratedAddress(1001);
  expect(integrated).toHaveLength(106);
  const fromIntegrated = await ViewPair.create(integrated, fixture.secret_view_key);
  expect(fromIntegrated.makeSubaddress(0)).toBe(fixture.primary_address);
});
