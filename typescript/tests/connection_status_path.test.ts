import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { writeConnectionStatusFile, readConnectionStatusDefaultLocation } from "../wallet-api/api";

test("connectionStatusFilePath with bare filename writes to cwd", async () => {
  await writeConnectionStatusFile(
    { last_packet: { status: "OK", bytes_read: 0, node_url: "http://localhost:18081", timestamp: new Date().toISOString() } },
    "SomeSettings.json",
  );
  const filePath = "ConnectionStatus-SomeSettings.json";
  expect(await Bun.file(filePath).exists()).toBe(true);
  await rm(filePath, { force: true });
});

test("connectionStatusFilePath with path in scan_settings_path writes to that dir", async () => {
  const dir = "tests/moneronode";
  const scanPath = `${dir}/MySettings.json`;

  await writeConnectionStatusFile(
    { last_packet: { status: "OK", bytes_read: 0, node_url: "http://localhost:18081", timestamp: new Date().toISOString() } },
    scanPath,
  );

  const filePath = `${dir}/ConnectionStatus-MySettings.json`;
  expect(await Bun.file(filePath).exists()).toBe(true);

  // verify no directory was created from the full path
  const badPath = `ConnectionStatus-${scanPath}`;
  expect(await Bun.file(badPath).exists()).toBe(false);

  // read back via the library function
  const read = await readConnectionStatusDefaultLocation(scanPath);
  expect(read).toBeDefined();
  expect(read!.last_packet.status).toBe("OK");

  await rm(filePath, { force: true });
});

test("readConnectionStatusDefaultLocation uses same path logic", async () => {
  const dir = "tests/moneronode";
  const scanPath = `${dir}/CheckSettings.json`;

  await writeConnectionStatusFile(
    { last_packet: { status: "connection_failed", bytes_read: 100, node_url: "http://localhost:18081", timestamp: new Date().toISOString() } },
    scanPath,
  );

  // must read from dir/ConnectionStatus-CheckSettings.json, not ConnectionStatus-tests/moneronode/CheckSettings.json
  const result = await readConnectionStatusDefaultLocation(scanPath);
  expect(result).toBeDefined();
  expect(result!.last_packet.status).toBe("connection_failed");

  await rm(`${dir}/ConnectionStatus-CheckSettings.json`, { force: true });
});

test("no directory is created by the path logic", async () => {
  const dir = "tests/moneronode";
  const scanPath = `${dir}/DirTest.json`;

  await writeConnectionStatusFile(
    { last_packet: { status: "OK", bytes_read: 0, node_url: "http://localhost:18081", timestamp: new Date().toISOString() } },
    scanPath,
  );

  // ConnectionStatus-tests/ should NOT exist as a directory
  const badDir = `ConnectionStatus-${dir}`;
  const stat = await Bun.file(badDir).exists().catch(() => false);
  expect(stat).toBe(false);

  await rm(`${dir}/ConnectionStatus-DirTest.json`, { force: true });
});
