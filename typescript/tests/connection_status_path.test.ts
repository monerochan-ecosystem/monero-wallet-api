import { test, expect, beforeAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { writeConnectionStatusFile, readConnectionStatusDefaultLocation, emptyConnectionStatus } from "../wallet-api/api";

const TEST_DATA_DIR = "test-data/connection_status_path";

beforeAll(async () => {
  await rm(TEST_DATA_DIR, { force: true, recursive: true });
  await mkdir(TEST_DATA_DIR, { recursive: true });
});

test("connectionStatusFilePath with bare filename writes to test data dir", async () => {
  const scanPath = `${TEST_DATA_DIR}/SomeSettings.json`;
  await writeConnectionStatusFile(
    emptyConnectionStatus({ last_packet: { status: "OK", bytes_read: 0, node_url: "http://localhost:18081", timestamp: new Date().toISOString() } }),
    scanPath,
  );
  const filePath = `${TEST_DATA_DIR}/ConnectionStatus-SomeSettings.json`;
  expect(await Bun.file(filePath).exists()).toBe(true);
});

test("connectionStatusFilePath with path in scan_settings_path writes to that dir", async () => {
  const scanPath = `${TEST_DATA_DIR}/MySettings.json`;

  await writeConnectionStatusFile(
    emptyConnectionStatus({ last_packet: { status: "OK", bytes_read: 0, node_url: "http://localhost:18081", timestamp: new Date().toISOString() } }),
    scanPath,
  );

  const filePath = `${TEST_DATA_DIR}/ConnectionStatus-MySettings.json`;
  expect(await Bun.file(filePath).exists()).toBe(true);

  // verify no directory was created from the full path
  const badPath = `ConnectionStatus-${scanPath}`;
  expect(await Bun.file(badPath).exists()).toBe(false);

  // read back via the library function
  const read = await readConnectionStatusDefaultLocation(scanPath);
  expect(read).toBeDefined();
  expect(read!.last_packet.status).toBe("OK");
});

test("readConnectionStatusDefaultLocation uses same path logic", async () => {
  const scanPath = `${TEST_DATA_DIR}/CheckSettings.json`;

  await writeConnectionStatusFile(
    emptyConnectionStatus({ last_packet: { status: "connection_failed", bytes_read: 100, node_url: "http://localhost:18081", timestamp: new Date().toISOString() } }),
    scanPath,
  );

  // must read from dir/ConnectionStatus-CheckSettings.json, not ConnectionStatus-test-data/connection_status_path/CheckSettings.json
  const result = await readConnectionStatusDefaultLocation(scanPath);
  expect(result).toBeDefined();
  expect(result!.last_packet.status).toBe("connection_failed");
});

test("no directory is created by the path logic", async () => {
  const scanPath = `${TEST_DATA_DIR}/DirTest.json`;

  await writeConnectionStatusFile(
    emptyConnectionStatus({ last_packet: { status: "OK", bytes_read: 0, node_url: "http://localhost:18081", timestamp: new Date().toISOString() } }),
    scanPath,
  );

  // ConnectionStatus-test-data/ should NOT exist as a directory
  const badDir = `ConnectionStatus-test-data`;
  const stat = await Bun.file(badDir).exists().catch(() => false);
  expect(stat).toBe(false);
});
