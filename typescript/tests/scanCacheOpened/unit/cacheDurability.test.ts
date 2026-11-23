import { expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import "../../../dist/xmr3";
import { atomicWrite } from "../../../dist/io/atomicWrite";
import { putFileIntoIndexedDB } from "../../../dist/io/indexedDB";

test("a cache write rejects if it cannot replace the target file", async () => {
  const dir = "test-data/cache-rename-failure";
  const target = `${dir}/wallet_cache.json`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  await expect(atomicWrite(target, "{}")).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["wallet_cache.json"]);
});

test("a browser cache write waits for commit and rejects on abort", async () => {
  const request = { onsuccess: () => {} };
  let put = Promise.withResolvers<void>();
  const tx = {
    objectStore: () => ({ put: () => { put.resolve(); return request; } }),
    oncomplete: () => {},
    onabort: () => {},
    error: new Error("transaction aborted"),
  };
  const browser = globalThis as typeof globalThis & { filesDb?: unknown };
  const previous = browser.filesDb;
  browser.filesDb = { transaction: () => tx };
  try {
    const write = putFileIntoIndexedDB("wallet_cache.json", "{}").catch((error: unknown) => error);
    await put.promise;
    request.onsuccess();
    tx.onabort();
    expect(await write).toBe(tx.error);

    put = Promise.withResolvers<void>();
    const committed = putFileIntoIndexedDB("wallet_cache.json", "{}");
    await put.promise;
    tx.oncomplete();
    expect(await committed).toBe(2);
  } finally {
    browser.filesDb = previous;
  }
});
