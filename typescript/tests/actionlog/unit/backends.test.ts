import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ActionLogOpened } from "../../../wallet-api/actionlog/actionLogOpened";

async function setup(name: string) {
  const folder = resolve("test-data/actionlog-backends", name);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  return folder;
}

test("the action log factory saves and reopens a SQLite invocation", async () => {
  const folder = await setup("sqlite");
  const options = { backend: "sqlite" as const, path: `${folder}/actionlog.sqlite` };
  const log = await ActionLogOpened.create(options);
  const started = await log.append({ type: "session_start", invocationId: "payment", stage: "invoked", toolId: "001" });
  await log.append({ type: "dismiss", invocationId: "payment", stage: "invoked", toolId: "001" });
  const reopened = await ActionLogOpened.create(options);
  const invocation = await reopened.invocation("payment");
  await Bun.write(`${folder}/result.json`, JSON.stringify(invocation, null, 2));
  expect(invocation?.events[0]).toEqual(started);
  expect(invocation?.events.map(event => event.type)).toEqual(["session_start", "dismiss"]);
  expect(invocation?.status).toBe("dismissed");
  expect(reopened.invocations("active")).toEqual([]);
});

test("the action log factory loads in a classic browser script without native modules", async () => {
  const folder = await setup("browser");
  const entry = `${folder}/entry.ts`;
  const source = resolve("wallet-api/actionlog/actionLogOpened.ts");
  await Bun.write(entry, `import { ActionLogOpened } from ${JSON.stringify(source)};
globalThis.openActionLog = () => ActionLogOpened.create({ backend: "idb" });`);
  const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" });
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  await Bun.write(`${folder}/bundle.js`, code);
  const context = { openActionLog: undefined as undefined | (() => Promise<unknown>) };
  runInNewContext(code, context);
  let error = "";
  try { await context.openActionLog!(); } catch (caught) { error = String(caught); }
  await Bun.write(`${folder}/result.json`, JSON.stringify({ error, bytes: code.length }, null, 2));
  expect(error).toContain("IndexedDB not available");
});
