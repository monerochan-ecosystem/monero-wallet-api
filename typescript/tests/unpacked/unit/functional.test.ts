import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

const OUT = "test-data/unpacked_functional";

async function clean() {
  await rm(OUT, { force: true, recursive: true }).catch(() => {});
  await mkdir(OUT, { recursive: true });
}

test("unpacked makeTestKeyPair works via file urls", async () => {
  await clean();
  const unpacked = await import("../../../dist/xmr3_unpacked.js");
  // point loader to dist wasm files
  unpacked.configureUnpacked({
    workerUrl: "dist/worker_unpacked.js",
    moneroWasmUrl: "dist/monero_wallet_api.wasm",
    dkgWasmUrl: "dist/frost_dkg.wasm",
  });
  // urls win over inline, so this uses file bytes even if packed ran before
  const fileBytes = new Uint8Array(
    await Bun.file("dist/monero_wallet_api.wasm").arrayBuffer(),
  );
  const loaderBytes = await unpacked.getMoneroWasmBytes();
  expect(loaderBytes.length).toBe(fileBytes.length);
  expect(loaderBytes[0]).toBe(0x00);
  expect(loaderBytes[1]).toBe(0x61);
  // real wasm call
  const kp = await unpacked.makeTestKeyPair();
  expect(kp.spend_key.length).toBe(64);
  expect(kp.view_key.mainnet_primary.length).toBeGreaterThan(90);
}, 10000);

test("unpacked parseAddress works", async () => {
  await clean();
  const unpacked = await import("../../../dist/xmr3_unpacked.js");
  unpacked.configureUnpacked({
    workerUrl: "dist/worker_unpacked.js",
    moneroWasmUrl: "dist/monero_wallet_api.wasm",
    dkgWasmUrl: "dist/frost_dkg.wasm",
  });
  const kp = await unpacked.makeTestKeyPair();
  const parsed = await unpacked.parseAddress(kp.view_key.mainnet_primary);
  expect("address" in parsed).toBe(true);
}, 10000);

test("unpacked worker starts and signals ready", async () => {
  await clean();
  const unpacked = await import("../../../dist/xmr3_unpacked.js");
  unpacked.configureUnpacked({
    workerUrl: `${process.cwd()}/dist/worker_unpacked.js`,
    moneroWasmUrl: `${process.cwd()}/dist/monero_wallet_api.wasm`,
    dkgWasmUrl: `${process.cwd()}/dist/frost_dkg.wasm`,
  });
  const worker = await unpacked.startWebworkerReady();
  expect(worker).toBeDefined();
  worker.terminate();
}, 10000);
