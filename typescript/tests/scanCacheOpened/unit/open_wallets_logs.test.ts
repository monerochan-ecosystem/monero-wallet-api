import { test, expect, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  openWallets,
  writeScanSettings,
  openScanSettingsFile,
} from "../../../dist/api";

const OUT = "test-data/open-wallets-logs";

beforeEach(async () => {
  await rm(OUT, { force: true, recursive: true });
  await mkdir(OUT, { recursive: true });
});

test("openWallets persists logs and logs_include into ScanSettings.json", async () => {
  const path = `${OUT}/ScanSettings.json`;
  await writeScanSettings(
    { wallets: [], node_url: "http://127.0.0.1:18081", start_height: null },
    path,
  );

  const many = await openWallets({
    scan_settings_path: path,
    no_worker: true,
    logs: "console",
    logs_include: [
      "handleCpuboundScan",
      "atomicWrite",
      "blocksBufferFetchLoop",
    ],
  });

  expect(many).toBeDefined();
  expect(many!.logs).toBe("console");
  expect(many!.logs_include).toEqual([
    "handleCpuboundScan",
    "atomicWrite",
    "blocksBufferFetchLoop",
  ]);

  const raw = await openScanSettingsFile(path);
  expect(raw?.logs).toBe("console");
  expect(raw?.logs_include).toEqual([
    "handleCpuboundScan",
    "atomicWrite",
    "blocksBufferFetchLoop",
  ]);
});

test("setLogSettings on Many works with zero wallets", async () => {
  const path = `${OUT}/ScanSettings.json`;
  await writeScanSettings(
    { wallets: [], node_url: "http://127.0.0.1:18081", start_height: null },
    path,
  );

  const many = await openWallets({
    scan_settings_path: path,
    no_worker: true,
  });

  await many!.setLogSettings("file", ["createWebworker"]);
  expect(many!.logs).toBe("file");
  expect(many!.logs_include).toEqual(["createWebworker"]);

  const raw = await openScanSettingsFile(path);
  expect(raw?.logs).toBe("file");
  expect(raw?.logs_include).toEqual(["createWebworker"]);
});
