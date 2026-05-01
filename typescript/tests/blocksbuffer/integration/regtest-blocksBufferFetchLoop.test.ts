import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  blocksBufferFetchLoop,
  setupBlocksBufferGenerator,
  handleConnectionStatusChanges,
  writeScanSettings,
  connectionStatusFilePath,
} from "../../../dist/api";
import type {
  GetBlocksBinBufferItem,
  BlocksBufferLoopResult,
} from "../../../dist/api";

const OUTPUT_DIR = "test-data/blocksbuffer/integration/output";
const MONEROD_PATH = "tests/moneronode/monerod";
const KEYPAIRS_PATH = "tests/moneronode/keypairs.json";
const RPC_PORT = 18088;
const NODE_URL = `http://127.0.0.1:${RPC_PORT}`;

async function waitForNode() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${NODE_URL}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
      });
      if (r.ok && (await r.json()).result?.height) break;
    } catch {}
    await Bun.sleep(500);
  }
}

async function rpc(method: string, params: any) {
  await fetch(`${NODE_URL}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
  });
}

// advance one generator until it yields a sync event.
// uses generator.next() directly (not for await...of) so the generator
// stays alive after return for await...of calls return() on exit.
async function advanceSync(
  generator: AsyncGenerator<BlocksBufferLoopResult>,
  scanSettingsPath: string,
): Promise<BlocksBufferLoopResult | undefined> {
  while (true) {
    const { value, done } = await generator.next();
    if (done) return undefined;
    if (value === "blocks_buffer_changed") continue;
    await handleConnectionStatusChanges(value, scanSettingsPath);
    if ("scanned_ranges" in value) return value;
  }
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
    await waitForNode();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text());
    const addr = kp[0].view_key.mainnet_primary;
    const { generator, blocksBuffer } = await setupBlocksBufferGenerator({
      nodeUrl: NODE_URL,
      startHeight: 0,
      scanSettingsPath: `${dir}/ScanSettings.json`,
    });
    await rpc("generateblocks", { amount_of_blocks: 10, wallet_address: addr });
    await advanceSync(generator, `${dir}/ScanSettings.json`);
    expect(blocksBuffer.length).toBeGreaterThan(0);
    const cs = JSON.parse(
      await Bun.file(
        connectionStatusFilePath(`${dir}/ScanSettings.json`),
      ).text(),
    );
    console.log(
      `[it2] status: ${cs.last_packet.status}, ranges: ${JSON.stringify(cs.sync.scanned_ranges?.slice(-1))}`,
    );
  } finally {
    proc.kill(9);
    try {
      await proc.exited;
    } catch {}
  }
}, 10000);

test("it3: regtest node, mine 400, kill, restart, cat reorg", async () => {
  const dir = `${OUTPUT_DIR}/it3`;
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
    await waitForNode();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text());
    const addr = kp[0].view_key.mainnet_primary;
    const { generator } = await setupBlocksBufferGenerator({
      nodeUrl: NODE_URL,
      startHeight: 0,
      scanSettingsPath: `${dir}/ScanSettings.json`,
    });
    for (let i = 0; i < 8; i++) {
      await rpc("generateblocks", {
        amount_of_blocks: 50,
        wallet_address: addr,
      });
      await advanceSync(generator, `${dir}/ScanSettings.json`);
    }
    console.log("[it3] mined 400, killing node");
  } finally {
    proc.kill(9);
    try {
      await proc.exited;
    } catch {}
    await Bun.sleep(1000);
  }

  const proc2 = Bun.spawn(
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
    await waitForNode();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text());
    const addr = kp[0].view_key.mainnet_primary;
    await rpc("generateblocks", { amount_of_blocks: 50, wallet_address: addr });

    const saved = JSON.parse(
      await Bun.file(
        connectionStatusFilePath(`${dir}/ScanSettings.json`),
      ).text(),
    );
    const anchor = saved.sync.scanned_ranges?.at(-1);
    console.log(`[it3] anchor: ${anchor?.start}-${anchor?.end}`);
    const { generator: gen2 } = await setupBlocksBufferGenerator({
      nodeUrl: NODE_URL,
      startHeight: 0,
      anchor_range: anchor,
      scanSettingsPath: `${dir}/ScanSettings.json`,
    });
    try {
      await advanceSync(gen2, `${dir}/ScanSettings.json`);
    } catch (e: any) {
      if (e?.name !== "CatastrophicReorgError") throw e;
    }
    const cs = JSON.parse(
      await Bun.file(
        connectionStatusFilePath(`${dir}/ScanSettings.json`),
      ).text(),
    );
    expect(cs.last_packet.status).toBe("catastrophic_reorg");
    console.log("[it3] catastrophic reorg confirmed");
  } finally {
    proc2.kill(9);
    try {
      await proc2.exited;
    } catch {}
  }
}, 20000);

test("it4: regtest node, two reorgs at non-zero split heights", async () => {
  const dir = `${OUTPUT_DIR}/it4`;
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
    await waitForNode();
    const kp = JSON.parse(await Bun.file(KEYPAIRS_PATH).text());
    const addr = kp[0].view_key.mainnet_primary;
    const addr1 = kp[1].view_key.mainnet_primary;

    const { generator, blocksBuffer } = await setupBlocksBufferGenerator({
      nodeUrl: NODE_URL,
      startHeight: 0,
      scanSettingsPath: `${dir}/ScanSettings.json`,
    });

    for (let i = 0; i < 6; i++) {
      await rpc("generateblocks", {
        amount_of_blocks: 50,
        wallet_address: addr,
      });
      await advanceSync(generator, `${dir}/ScanSettings.json`);
    }
    console.log("[it4] mined 300, anchors advanced");

    // first reorg
    await fetch(`${NODE_URL}/pop_blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nblocks: 5 }),
    });
    await rpc("generateblocks", { amount_of_blocks: 5, wallet_address: addr1 });
    await advanceSync(generator, `${dir}/ScanSettings.json`);
    const cs1 = JSON.parse(
      await Bun.file(
        connectionStatusFilePath(`${dir}/ScanSettings.json`),
      ).text(),
    );
    expect(cs1.last_packet.status).toBe("OK");
    expect(cs1.sync.reorg_info?.split_heights?.length).toBe(1);
    expect(
      cs1.sync.reorg_info?.split_heights?.[0]?.block_height,
    ).toBeGreaterThan(200);
    console.log(
      `[it4] first reorg: split at ${cs1.sync.reorg_info?.split_heights?.[0]?.block_height}`,
    );

    // second reorg
    await fetch(`${NODE_URL}/pop_blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nblocks: 60 }),
    });
    await rpc("generateblocks", {
      amount_of_blocks: 60,
      wallet_address: addr1,
    });
    await advanceSync(generator, `${dir}/ScanSettings.json`);
    const cs2 = JSON.parse(
      await Bun.file(
        connectionStatusFilePath(`${dir}/ScanSettings.json`),
      ).text(),
    );
    expect(cs2.last_packet.status).toBe("OK");
    expect(cs2.sync.reorg_info?.split_heights?.length).toBe(2);
    console.log(
      `[it4] second reorg: heights=[${cs2.sync.reorg_info?.split_heights?.map((h: any) => h.block_height).join(",")}]`,
    );

    // mine 100 more, anchors advance
    await rpc("generateblocks", {
      amount_of_blocks: 100,
      wallet_address: addr,
    });
    await advanceSync(generator, `${dir}/ScanSettings.json`);
    const cs3 = JSON.parse(
      await Bun.file(
        connectionStatusFilePath(`${dir}/ScanSettings.json`),
      ).text(),
    );
    const anchors =
      cs3.sync.scanned_ranges
        ?.at(-1)
        ?.block_hashes?.map((h: any) => h.block_height) ?? [];
    console.log(`[it4] after +100: anchors=[${anchors.join(",")}]`);
    expect(anchors[2]).toBeGreaterThan(0);
    expect(blocksBuffer.length).toBeGreaterThan(0);
  } finally {
    proc.kill(9);
    try {
      await proc.exited;
    } catch {}
  }
}, 60000);
// note: don't bump timeouts above 20s, all tests finish under 16s total.
// if a test times out the bug is elsewhere, not the timeout.
