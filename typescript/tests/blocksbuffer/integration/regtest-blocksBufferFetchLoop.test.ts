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

const MONEROD_PATH = "tests/moneronode/monerod";
const KEYPAIRS_PATH = "tests/moneronode/keypairs.json";
const RPC_PORT = 18088;
const NODE_URL = `http://127.0.0.1:${RPC_PORT}`;

async function waitForNode(url: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
      });
      if (r.ok && (await r.json()).result?.height) break;
    } catch {}
    await Bun.sleep(500);
  }
}

async function rpc(url: string, method: string, params: any) {
  await fetch(`${url}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
  });
}

test("it2: regtest node, barebones coordinator", async () => {
  const dir = `${OUTPUT_DIR}/it2`;
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
      node_url: NODE_URL,
      start_height: 0,
    },
    `${dir}/ScanSettings.json`,
  );

  const proc = Bun.spawn(
    [
      MONEROD_PATH,
      "--regtest",
      "--offline",
      "--fixed-difficulty",
      "1",
      "--rpc-bind-ip",
      "127.0.0.1",
      "--rpc-bind-port",
      String(RPC_PORT),
      "--non-interactive",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  try {
    await waitForNode(NODE_URL);
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text());
    const addr = kp[0].view_key.mainnet_primary;

    await rpc(NODE_URL, "generateblocks", {
      amount_of_blocks: 10,
      wallet_address: addr,
    });
    console.log("[IT2] generated 10 blocks");

    const buffer: GetBlocksBinBufferItem[] = [];
    const cs: ConnectionStatus = emptyConnectionStatus();
    const gen = blocksBufferFetchLoop(NODE_URL, 0, buffer, cs);

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
      if (buffer.length > 0 && yields >= 4) break;
    }

    expect(yields).toBeGreaterThan(0);
    expect(buffer.length).toBeGreaterThan(0);

    // inspect conn status file written by coordinator
    const connPath = connectionStatusFilePath(`${dir}/ScanSettings.json`);
    const csData = JSON.parse(await Bun.file(connPath).text());
    console.log(
      `[IT2] status: ${csData.last_packet.status}, ranges: ${JSON.stringify(csData.sync.scanned_ranges?.slice(-1))}, buffer: ${buffer.length}`,
    );
  } finally {
    proc.kill(9);
    try {
      await proc.exited;
    } catch {}
  }
}, 10000);
// note: don't bump timeouts above 20s, all tests finish under 16s total.
// if a test times out the bug is elsewhere, not the timeout.
