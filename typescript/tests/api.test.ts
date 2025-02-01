import { test, mock } from "bun:test";
import { NodeUrl, ViewPair } from "../wallet-api/api";
import { get_info } from "../wallet-api/node-interaction/jsonEndpoints";
import * as binEndponts from "../wallet-api/node-interaction/binaryEndpoints.ts";
const originalBinaryFetch = binEndponts.binaryFetchRequest;
let currentFilename = "";
const mockBinaryFetch = mock(async (url: string, body: Uint8Array) => {
  let result = await originalBinaryFetch(url, body);
  const filename = Bun.hash(result);
  currentFilename = filename + "";
  await Bun.write("tests/fixtures/getBlocksBinResponse/" + filename, result);
  result = new Uint8Array(
    await Bun.file(
      "tests/fixtures/getBlocksBinResponse/" + filename
    ).arrayBuffer()
  );
  return result;
});
mock.module("../wallet-api/node-interaction/binaryEndpoints.ts", () => {
  return {
    ...binEndponts,
    binaryFetchRequest: mockBinaryFetch,
  };
});
// git clone monero-playground run:
// ./monerod --stagenet --rpc-bind-port 38081 --p2p-bind-port 38080
const STAGENET_URL = "http://localhost:38081";

const PRIMARY_ADDRESS =
  "5B5ieVKGSyfAyh68X6AFB48Gnx9diT8jPbWN6UcZHJUZVQSLRhaaHuHQz3dGuxxZDXPYgCXzrkerK3m6Q1tHoougR7VYyd9";
const SECRET_VIEW_KEY =
  "10b9885324933ee6055b001a3ee4b70f6832b866db389ad023b51fe7e2e7ca01";
test("fetch blocks starting from latest height", async () => {
  // Make the initial get_info request
  const getInfoResult = await get_info(STAGENET_URL);
  // Now fetch blocks starting from the latest height
  const viewPair = await ViewPair.create(
    PRIMARY_ADDRESS,
    SECRET_VIEW_KEY,
    STAGENET_URL
  );
  const blocks = await viewPair.getBlocksBin({
    start_height: getInfoResult.height - 10,
  });
  console.log(
    `${currentFilename} ViewPair, Fetched blocks starting from height ${
      getInfoResult.height
    } , ${JSON.stringify(blocks)}`
  );
});
test("fetch blocks starting from latest height", async () => {
  // Make the initial get_info request
  const getInfoResult = await get_info(STAGENET_URL);
  // Now fetch blocks starting from the latest height
  const nodeUrl = await NodeUrl.create(STAGENET_URL);
  const blocks = await nodeUrl.getBlocksBin({
    start_height: getInfoResult.height - 1,
  });
  console.log(
    `${currentFilename} NodeUrl, Fetched blocks starting from height ${
      getInfoResult.height
    } , ${JSON.stringify(blocks)}`
  );
});
