import { test } from "bun:test";
import { NodeUrl } from "../wallet-api/node-interaction/nodeUrl";
import { mkdir } from "node:fs/promises";

const NODE_URL = "https://xmr-01.tari.com";
const START_HEIGHT = 3160222;
const FIXTURES_DIR = "tests/fixtures/node_url_getblocks_bin_scan";
const FIXTURE_RESPONSE = `${FIXTURES_DIR}/getblocks.bin.plus30000.response`;
const FIXTURE_RESPONSE_PLUS_40000 = `${FIXTURES_DIR}/getblocks.bin.plus40000.response`;
const FIXTURE_RESPONSE_PLUS_50000 = `${FIXTURES_DIR}/getblocks.bin.plus50000.response`;
const TEST_RESULTS_DIR = "tests/testresults";

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
  "loadGetBlocksBinResponse",
  async () => {
    await setupFixtures();
  },
  { timeout: 60000 },
);
