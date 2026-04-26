import { test } from "bun:test";
import { ViewPair } from "../wallet-api/api";
import {
  makeTestKeyPair,
  type Keypair,
} from "../wallet-api/keypairs-seeds/keypairs";
import { mkdir } from "node:fs/promises";

const NODE_URL = "https://xmr-01.tari.com";
const START_HEIGHT = 3160222;
const FIXTURES_DIR = "tests/fixtures/view_pair_getblocks_bin_scan";
const FIXTURE_KEYPAIR = `${FIXTURES_DIR}/keypair.json`;
const FIXTURE_RESPONSE = `${FIXTURES_DIR}/getblocks.bin.response`;

async function setupFixtures() {
  const keypairFile = Bun.file(FIXTURE_KEYPAIR);
  const responseFile = Bun.file(FIXTURE_RESPONSE);
  if ((await keypairFile.exists()) && (await responseFile.exists())) {
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
}

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

    const result = await viewPair.getBlocksBinScanResponse(
      getBlocksBinResponse,
      (meta) => {
        console.log("meta callback:", meta);
      },
    );
    console.log(
      "scan result:",
      JSON.stringify(result, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
  },
  { timeout: 60000 },
);

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
  },
  { timeout: 60000 },
);
