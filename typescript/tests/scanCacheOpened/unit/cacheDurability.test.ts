import { expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { readStatsFileDefaultLocation, writeStatsFileDefaultLocation, type TxLog } from "../../../dist/xmr3";
import { atomicWrite } from "../../../dist/io/atomicWrite";
import { putFileIntoIndexedDB } from "../../../dist/io/indexedDB";

for (const metadata of [
  { amount: "12.50", parts: [{ amount: null }, { amount: false }], pending_amount: "application value" },
  { amount: 7, parts: [{ amount: 2 }], pending_amount: "7" },
]) {
  test(`stats reopen preserves metadata amount ${JSON.stringify(metadata.amount)} and wallet amounts`, async () => {
    const dir = `test-data/stats-metadata-${typeof metadata.amount}`;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const txlog: TxLog = {
      inputs_index: ["7"], payments: [{ address: "merchant", amount: "30" }],
      node_url: "node", height: 10, timestamp: 1, metadata,
    };
    await writeStatsFileDefaultLocation({
      primary_address: "stats-wallet", pathPrefix: `${dir}/`,
      writeCallback: (stats) => {
        stats.total_pending_amount = 30n;
        stats.primary_address_received_amount = 100n;
        stats.primary_address_pending_amount = 20n;
        stats.subaddresses["1"] = { pending_amount: 10n } as typeof stats.subaddresses[string];
        stats.found_transactions.sent = {
          amount: -30n, inputs: [], outputs: [], tx_hash: "sent",
          status: { status: "pending", unlock_height: 0 }, payment_id: 0, confirmations: 0, txlog,
        };
      },
    });
    const restored = await readStatsFileDefaultLocation("stats-wallet", `${dir}/`);
    expect(restored?.found_transactions.sent?.txlog?.metadata).toEqual(metadata);
    expect(restored?.found_transactions.sent?.txlog?.payments[0]?.amount).toBe(30n);
    expect(restored?.found_transactions.sent?.amount).toBe(-30n);
    expect(restored?.total_pending_amount).toBe(30n);
    expect(restored?.primary_address_received_amount).toBe(100n);
    expect(restored?.primary_address_pending_amount).toBe(20n);
    expect(restored?.subaddresses["1"]?.pending_amount).toBe(10n);
  });
}

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
