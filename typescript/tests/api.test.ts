import { test } from "bun:test";
import { NodeUrl } from "../wallet-api/api";
import { get_info } from "../wallet-api/node-interaction/jsonEndpoints";
import { sleep } from "bun";
// git clone monero-playground run:
// ./monerod --stagenet --rpc-bind-port 38081 --p2p-bind-port 38080
const STAGENET_URL = "http://localhost:38081";
test("fetch blocks starting from latest height", async () => {
  // Make the initial get_info request
  const getInfoResult = await get_info(STAGENET_URL);
  // Now fetch blocks starting from the latest height
  const nodeUrl = await NodeUrl.create(STAGENET_URL);
  const blocks = await nodeUrl.getBlocksBin({
    start_height: getInfoResult.height - 1,
  });
  await sleep(5000);
  // Add assertions here if needed
  console.log(`Fetched blocks starting from height ${getInfoResult.height}`);
});
