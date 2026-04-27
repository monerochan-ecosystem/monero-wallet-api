import { test, beforeAll } from "bun:test";
import { NodeUrl } from "../wallet-api/node-interaction/nodeUrl";
import type { GetBlocksResultMeta } from "../wallet-api/node-interaction/binaryEndpoints";
import { mkdir, rm } from "node:fs/promises";

const TEST_DATA_DIR = "test-data/node_url_getblocks_bin_scan";

beforeAll(async () => {
  await rm(TEST_DATA_DIR, { force: true, recursive: true });
  await mkdir(TEST_DATA_DIR, { recursive: true });
});

const NODE_URL = "https://xmr-01.tari.com";
const START_HEIGHT = 3160222;
const FIXTURES_DIR = "tests/fixtures/node_url_getblocks_bin_scan";
const FIXTURE_RESPONSE = `${FIXTURES_DIR}/getblocks.bin.plus30000.response`;
const FIXTURE_RESPONSE_PLUS_40000 = `${FIXTURES_DIR}/getblocks.bin.plus40000.response`;
const FIXTURE_RESPONSE_PLUS_50000 = `${FIXTURES_DIR}/getblocks.bin.plus50000.response`;
// no shared TEST_RESULTS_DIR — each test file uses test-data/<test-name>/

async function setupFixtures() {
  const responseFile = Bun.file(FIXTURE_RESPONSE);
  const responseFilePlus40000 = Bun.file(FIXTURE_RESPONSE_PLUS_40000);
  const responseFilePlus50000 = Bun.file(FIXTURE_RESPONSE_PLUS_50000);
  if (
    (await responseFile.exists()) &&
    (await responseFilePlus40000.exists()) &&
    (await responseFilePlus50000.exists())
  ) {
    return;
  }

  await mkdir(FIXTURES_DIR, { recursive: true });

  const nodeUrl = await NodeUrl.create(NODE_URL);

  const response = await nodeUrl.getBlocksBinExecuteRequest({
    start_height: START_HEIGHT + 30000,
  });
  await Bun.write(FIXTURE_RESPONSE, response);

  const responsePlus40000 = await nodeUrl.getBlocksBinExecuteRequest({
    start_height: START_HEIGHT + 40000,
  });
  await Bun.write(FIXTURE_RESPONSE_PLUS_40000, responsePlus40000);

  const responsePlus50000 = await nodeUrl.getBlocksBinExecuteRequest({
    start_height: START_HEIGHT + 50000,
  });
  await Bun.write(FIXTURE_RESPONSE_PLUS_50000, responsePlus50000);
}

test(
  "loadGetBlocksBinResponse three times with different heights",
  async () => {
    await setupFixtures();
    const getBlocksBinResponse = new Uint8Array(
      await Bun.file(FIXTURE_RESPONSE).arrayBuffer(),
    );
    const getBlocksBinResponsePlus40000 = new Uint8Array(
      await Bun.file(FIXTURE_RESPONSE_PLUS_40000).arrayBuffer(),
    );
    const getBlocksBinResponsePlus50000 = new Uint8Array(
      await Bun.file(FIXTURE_RESPONSE_PLUS_50000).arrayBuffer(),
    );

    const nodeUrl = await NodeUrl.create(NODE_URL);

    const meta1 = await nodeUrl.loadGetBlocksBinResponse(getBlocksBinResponse);
    const meta2 = await nodeUrl.loadGetBlocksBinResponse(
      getBlocksBinResponsePlus40000,
    );
    const meta3 = await nodeUrl.loadGetBlocksBinResponse(
      getBlocksBinResponsePlus50000,
    );

    if ("error" in meta1) throw new Error("meta1 has error: " + (meta1 as any).error);
    if ("error" in meta2) throw new Error("meta2 has error: " + (meta2 as any).error);
    if ("error" in meta3) throw new Error("meta3 has error: " + (meta3 as any).error);

    if (
      meta1.new_height === meta2.new_height ||
      meta2.new_height === meta3.new_height ||
      meta1.new_height === meta3.new_height
    ) {
      throw new Error(
        "Expected different new_heights, got " +
          JSON.stringify({
            meta1: meta1.new_height,
            meta2: meta2.new_height,
            meta3: meta3.new_height,
          }),
      );
    }

    await Bun.write(
      `${TEST_DATA_DIR}/nodeUrl.loadGetBlocksBinResponse.result.json`,
      JSON.stringify({ meta1, meta2, meta3 }, null, 2),
    );
  },
  { timeout: 120000 },
);
