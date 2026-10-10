import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

const OUT = "test-data/unpacked_wasm_loader";

async function clean() {
  await rm(OUT, { force: true, recursive: true }).catch(() => {});
  await mkdir(OUT, { recursive: true });
}

test("packed loader returns inline bytes", async () => {
  await clean();
  const packed = await import("../../../dist/xmr3.js");
  const { getMoneroWasmBytes, getDkgWasmBytes, resetWasmLoaderForTests } = await import(
    "../../../dist/wasm-processing/wasmLoader.js"
  );
  // clear urls so inline wins, packed entry injects inline on import
  resetWasmLoaderForTests();
  const monero = await getMoneroWasmBytes();
  const dkg = await getDkgWasmBytes();
  expect(monero.length).toBeGreaterThan(100000);
  expect(dkg.length).toBeGreaterThan(100000);
  // wasm magic header
  expect(monero[0]).toBe(0x00);
  expect(monero[1]).toBe(0x61);
  expect(monero[2]).toBe(0x73);
  expect(monero[3]).toBe(0x6d);
});

test("unpacked loader fetches from files", async () => {
  await clean();
  // urls win over inline, so this tests file path even after packed import
  const { setWasmUrls, getMoneroWasmBytes } = await import(
    "../../../dist/wasm-processing/wasmLoader.js"
  );
  setWasmUrls({ monero: "dist/monero_wallet_api.wasm", dkg: "dist/frost_dkg.wasm" });
  const viaLoader = await getMoneroWasmBytes();
  expect(viaLoader[0]).toBe(0x00);
  expect(viaLoader.length).toBeGreaterThan(100000);
  const moneroFile = Bun.file("dist/monero_wallet_api.wasm");
  const dkgFile = Bun.file("dist/frost_dkg.wasm");
  expect(await moneroFile.exists()).toBe(true);
  expect(await dkgFile.exists()).toBe(true);
  const moneroBytes = new Uint8Array(await moneroFile.arrayBuffer());
  const dkgBytes = new Uint8Array(await dkgFile.arrayBuffer());
  expect(moneroBytes.length).toBeGreaterThan(100000);
  expect(dkgBytes.length).toBeGreaterThan(100000);
  expect(moneroBytes[0]).toBe(0x00);
  expect(moneroBytes[1]).toBe(0x61);
});

test("unpacked entry exports configure", async () => {
  await clean();
  const unpacked = await import("../../../dist/xmr3_unpacked.js");
  expect(typeof unpacked.configureUnpacked).toBe("function");
  expect(typeof unpacked.setWasmUrls).toBe("function");
  expect(typeof unpacked.setWorkerUrl).toBe("function");
  expect(typeof unpacked.openWallets).toBe("function");
  expect(typeof unpacked.ViewPair).toBe("function");
});

test("worker_unpacked file is readable and has no base64 wasm", async () => {
  await clean();
  const workerFile = Bun.file("dist/worker_unpacked.js");
  expect(await workerFile.exists()).toBe(true);
  const text = await workerFile.text();
  expect(text.length).toBeGreaterThan(100000);
  expect(text.length).toBeLessThan(1000000);
  // no wasm base64 header
  expect(text.includes("AGFzbQE")).toBe(false);
  // has worker ready signal
  expect(text.includes("WORKER_READY")).toBe(true);
  // has setup handler
  expect(text.includes("cpubound")).toBe(true);
});

test("unpacked main bundle has no inline wasm when bundled", async () => {
  await clean();
  // bundle a small entry that imports unpacked
  const result = await Bun.build({
    entrypoints: ["tests/unpacked/fixture/unpacked_entry.ts"],
    target: "browser",
  });
  expect(result.success).toBe(true);
  const outText = await result.outputs[0].text();
  // must not contain wasm base64
  expect(outText.includes("AGFzbQE")).toBe(false);
  // must not contain packed worker base64 (workerMainCodeToBase64 output is large)
  // packed worker.js is 4MB, unpacked bundle must stay small
  expect(outText.length).toBeLessThan(2000000);
});
