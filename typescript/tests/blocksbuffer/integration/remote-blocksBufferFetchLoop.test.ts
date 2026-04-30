/**
 * blocksBufferFetchLoop.test.ts, generator integration tests.
 * barebones blocks coordinator: iterates generator, writes last_packet
 * and sync to connection status file via readWriteConnectionStatusFile.
 */
import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  blocksBufferFetchLoop,
  emptyConnectionStatus,
  readWriteConnectionStatusFile,
  writeScanSettings,
  connectionStatusFilePath,
} from "../../../dist/api";
import type {
  GetBlocksBinBufferItem,
  ConnectionStatus,
} from "../../../dist/api";

const OUTPUT_DIR = "test-data/blocksbuffer/integration/output";

const REMOTE_URL = "https://xmr-01.tari.com";
const START_HEIGHT = 3160222;

test("it1: remote node, barebones coordinator", async () => {
  const dir = `${OUTPUT_DIR}/it1`;
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });

  await writeScanSettings(
    {
      wallets: [
        {
          primary_address:
            "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A",
        },
      ],
      node_url: REMOTE_URL,
      start_height: START_HEIGHT,
    },
    `${dir}/ScanSettings.json`,
  );

  const buffer: GetBlocksBinBufferItem[] = [];
  const cs: ConnectionStatus = emptyConnectionStatus();
  const gen = blocksBufferFetchLoop(REMOTE_URL, START_HEIGHT, buffer, cs);

  let yields = 0;
  for await (const event of gen) {
    yields++;
    if (event === "blocks_buffer_changed") continue;
    if ("status" in event) {
      await readWriteConnectionStatusFile((cs2) => {
        cs2.last_packet = event;
      }, `${dir}/ScanSettings.json`);
    } else {
      await readWriteConnectionStatusFile((cs2) => {
        cs2.sync = event;
      }, `${dir}/ScanSettings.json`);
    }
    if (yields >= 6) break;
  }

  expect(yields).toBeGreaterThanOrEqual(3);
  expect(buffer.length).toBeGreaterThan(0);

  // inspect conn status file written by coordinator
  const connPath = connectionStatusFilePath(`${dir}/ScanSettings.json`);
  const csFile = await Bun.file(connPath).exists();
  console.log(
    `[IT1] conn status file exists: ${csFile}, size: ${csFile ? await Bun.file(connPath).size : 0}`,
  );
  if (csFile) {
    const csData = JSON.parse(await Bun.file(connPath).text());
    console.log(
      `[IT1] last_packet.status: ${csData.last_packet.status}, scanned_ranges: ${JSON.stringify(csData.sync.scanned_ranges?.slice(-1))}`,
    );
  }
}, 20000);

// note: don't bump timeouts above 20s, all tests finish under 16s total.
// if a test times out the bug is elsewhere, not the timeout.
