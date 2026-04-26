import { test } from "bun:test";
import { ViewPair } from "../wallet-api/api";
import {
  makeTestKeyPair,
  type Keypair,
} from "../wallet-api/keypairs-seeds/keypairs";
import { mkdir } from "node:fs/promises";
import type { GetBlocksResultMeta } from "../wallet-api/node-interaction/binaryEndpoints";

const NODE_URL = "https://xmr-01.tari.com";
const START_HEIGHT = 3160222;
const FIXTURES_DIR = "tests/fixtures/view_pair_getblocks_bin_scan";
const FIXTURE_KEYPAIR = `${FIXTURES_DIR}/keypair.json`;
const FIXTURE_RESPONSE = `${FIXTURES_DIR}/getblocks.bin.response`;
const FIXTURE_RESPONSE_PLUS_10000 = `${FIXTURES_DIR}/getblocks.bin.plus10000.response`;
const FIXTURE_RESPONSE_PLUS_20000 = `${FIXTURES_DIR}/getblocks.bin.plus20000.response`;
const TEST_RESULTS_DIR = "tests/testresults";

async function setupFixtures() {
  const keypairFile = Bun.file(FIXTURE_KEYPAIR);
  const responseFile = Bun.file(FIXTURE_RESPONSE);
  const responseFilePlus10000 = Bun.file(FIXTURE_RESPONSE_PLUS_10000);
  const responseFilePlus20000 = Bun.file(FIXTURE_RESPONSE_PLUS_20000);
  if (
    (await keypairFile.exists()) &&
    (await responseFile.exists()) &&
    (await responseFilePlus10000.exists()) &&
    (await responseFilePlus20000.exists())
  ) {
    return;
  }

  await mkdir(FIXTURES_DIR, { recursive: true });

  const keypair = await makeTestKeyPair();
  await Bun.write(FIXTURE_KEYPAIR, JSON.stringify(keypair, null, 2));

  const viewPair = await ViewPair.create(
    keypair.view_key.mainnet_primary,
    keypair.view_key.view_key,
    0,
    NODE_URL,
  );

  const response = await viewPair.getBlocksBinExecuteRequest({
    start_height: START_HEIGHT,
  });
  await Bun.write(FIXTURE_RESPONSE, response);

  const responsePlus10000 = await viewPair.getBlocksBinExecuteRequest({
    start_height: START_HEIGHT + 10000,
  });
  await Bun.write(FIXTURE_RESPONSE_PLUS_10000, responsePlus10000);

  const responsePlus20000 = await viewPair.getBlocksBinExecuteRequest({
    start_height: START_HEIGHT + 20000,
  });
  await Bun.write(FIXTURE_RESPONSE_PLUS_20000, responsePlus20000);
}
test(
  "getBlocksBinScanOneBlock",
  async () => {
    await setupFixtures();
    const keypair = JSON.parse(
      await Bun.file(FIXTURE_KEYPAIR).text(),
    ) as Keypair;
    const getBlocksBinResponse = new Uint8Array(
      await Bun.file(FIXTURE_RESPONSE).arrayBuffer(),
    );

    const viewPair = await ViewPair.create(
      keypair.view_key.mainnet_primary,
      keypair.view_key.view_key,
      0,
      NODE_URL,
    );

    const meta = await viewPair.loadGetBlocksBinResponse(getBlocksBinResponse);
    if ("error" in meta) throw new Error("meta has error: " + meta.error);

    const scanResults = [];
    for (let i = 0; i < meta.block_infos.length; i++) {
      const result = await viewPair.getBlocksBinScanOneBlock(i);
      if ("error" in result) throw new Error("error scanning block " + i + ": " + (result as { error: string }).error);
      scanResults.push({
        block_index: i,
        block_height: meta.block_infos[i].block_height,
        result: JSON.parse(
          JSON.stringify(result, (_, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
        ),
      });
    }

    await mkdir(TEST_RESULTS_DIR, { recursive: true });
    await Bun.write(
      `${TEST_RESULTS_DIR}/getBlocksBinScanOneBlock.result.json`,
      JSON.stringify({ meta, scanResults }, null, 2),
    );
  },
  { timeout: 60000 },
);

test(
  "loadGetBlocksBinResponse three times with different heights",
  async () => {
    await setupFixtures();
    const keypair = JSON.parse(
      await Bun.file(FIXTURE_KEYPAIR).text(),
    ) as Keypair;
    const getBlocksBinResponse = new Uint8Array(
      await Bun.file(FIXTURE_RESPONSE).arrayBuffer(),
    );
    const getBlocksBinResponsePlus10000 = new Uint8Array(
      await Bun.file(FIXTURE_RESPONSE_PLUS_10000).arrayBuffer(),
    );
    const getBlocksBinResponsePlus20000 = new Uint8Array(
      await Bun.file(FIXTURE_RESPONSE_PLUS_20000).arrayBuffer(),
    );

    const viewPair = await ViewPair.create(
      keypair.view_key.mainnet_primary,
      keypair.view_key.view_key,
      0,
      NODE_URL,
    );

    const meta1 = await viewPair.loadGetBlocksBinResponse(getBlocksBinResponse);
    const meta2 = await viewPair.loadGetBlocksBinResponse(
      getBlocksBinResponsePlus10000,
    );
    const meta3 = await viewPair.loadGetBlocksBinResponse(
      getBlocksBinResponsePlus20000,
    );

    if ("error" in meta1) throw new Error("meta1 has error: " + meta1.error);
    if ("error" in meta2) throw new Error("meta2 has error: " + meta2.error);
    if ("error" in meta3) throw new Error("meta3 has error: " + meta3.error);

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

    await mkdir(TEST_RESULTS_DIR, { recursive: true });
    await Bun.write(
      `${TEST_RESULTS_DIR}/loadGetBlocksBinResponse.result.json`,
      JSON.stringify(
        {
          meta1,
          meta2,
          meta3,
        },
        null,
        2,
      ),
    );
  },
  { timeout: 120000 },
);

test(
  "getBlocksBinClassicScanResponse",
  async () => {
    await setupFixtures();
    const keypair = JSON.parse(
      await Bun.file(FIXTURE_KEYPAIR).text(),
    ) as Keypair;
    const getBlocksBinResponse = new Uint8Array(
      await Bun.file(FIXTURE_RESPONSE).arrayBuffer(),
    );

    const viewPair = await ViewPair.create(
      keypair.view_key.mainnet_primary,
      keypair.view_key.view_key,
      0,
      NODE_URL,
    );

    // This test saves its output to tests/testresults/getBlocksBinClassicScanResponse.result.json
    // The JSON includes timestamps for when the meta callback arrives and when the scan finishes,
    // plus the duration between those two events in seconds.
    await mkdir(TEST_RESULTS_DIR, { recursive: true });

    let metaTimestamp: string | null = null;
    let metaData: unknown = null;

    const result = await viewPair.getBlocksBinScanResponse(
      getBlocksBinResponse,
      (meta) => {
        metaTimestamp = new Date().toISOString();
        metaData = meta;
      },
    );

    const finishTimestamp = new Date().toISOString();
    const durationSeconds = metaTimestamp
      ? (new Date(finishTimestamp).getTime() -
          new Date(metaTimestamp).getTime()) /
        1000
      : null;

    const output = {
      durationSeconds,
      metaTimestamp,
      finishTimestamp,
      meta: metaData,
      result: JSON.parse(
        JSON.stringify(result, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ),
    };

    await Bun.write(
      `${TEST_RESULTS_DIR}/getBlocksBinClassicScanResponse.result.json`,
      JSON.stringify(output, null, 2),
    );
  },
  { timeout: 60000 },
);
