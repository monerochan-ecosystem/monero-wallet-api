import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

// tsc does not check the tests. so these tests read the declarations
// that users of the library compile against.
const dist = `${import.meta.dir}/../../../dist`;
const dir = `${import.meta.dir}/../../../test-data/send_types`;

beforeAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
});

// the declaration file with all whitespace as single spaces
async function declarations(path: string) {
  return (await Bun.file(`${dist}/${path}`).text()).replace(/\s+/g, " ");
}

// one method declaration, from its start to the end of its return type
function method(source: string, start: string) {
  const from = source.indexOf(start);
  if (from < 0) return `missing: ${start}`;
  return source.slice(from, source.indexOf(">;", from) + 2);
}

describe("action log bus send types", () => {
  test("callExtensionBackground gives a send command the wallet method's result type", async () => {
    const call = method(await declarations("actionlog/actionLogOpened.d.ts"), "callExtensionBackground<K");
    await Bun.write(`${dir}/call-extension-background.txt`, `${call}\n`);
    expect(call).toEndWith(
      ": Promise<K extends keyof ExtensionBackgroundResults ? ExtensionBackgroundResults[K] : unknown>;",
    );
  });

  test("callExtensionSidebar gives the caller nothing to wait for, and send is gone", async () => {
    const source = await declarations("actionlog/actionLogOpened.d.ts");
    const sidebar = "callExtensionSidebar<K extends keyof ExtensionMessageByKind>(kind: K, payload: ExtensionMessageByKind[K]): void;";
    await Bun.write(`${dir}/call-extension-sidebar.txt`, `${source.includes(sidebar) ? sidebar : "missing"}\n`);
    expect(source).toContain(sidebar);
    expect(source).not.toContain(" send<K");
  });

  test("the 3 send methods of ManyScanCachesOpened have one result type on both roles", async () => {
    const source = await declarations("scanning-syncing/scanresult/scanCacheOpened.d.ts");
    const found = [
      'makeSignSend(params: ExtensionMessageByKind["worker.makeSignSend"])',
      'sweepSignSend(params: ExtensionMessageByKind["worker.sweepSignSend"])',
      "rebroadcastTx(params: { primary_address: string; tx_log_index: number; })",
    ].map((start) => method(source, start));
    await Bun.write(`${dir}/mco-sends.txt`, `${found.join("\n")}\n`);
    for (const declaration of found)
      expect(declaration).toEndWith("): Promise<SendRawTransactionResult>;");
  });
});
