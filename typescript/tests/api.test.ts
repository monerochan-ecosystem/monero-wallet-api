import { test } from "bun:test";
import { NodeUrl } from "../wallet-api/api";
import { parseGetInfoResponse } from "../wallet-api/api";
import { sleep } from "bun";
// git clone monero-playground run:
// ./monerod --stagenet --rpc-bind-port 38081 --p2p-bind-port 38080
const STAGENET_URL = "http://localhost:38081";
test("fetch blocks starting from latest height", async () => {
  // Make the initial get_info request
  const getInfoResponse = await fetch(STAGENET_URL + "/json_rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "0",
      method: "get_info",
    }),
  });

  if (!getInfoResponse.ok) {
    throw new Error(`Failed to get info: ${getInfoResponse.statusText}`);
  }

  const getInfoResult = await getInfoResponse.json();

  const parsedResult = parseGetInfoResponse(getInfoResult);

  if (parsedResult === null || !parsedResult.result?.height) {
    throw new Error("Failed to get height from get_info result");
  }

  console.log(parsedResult);
  const startHeight = parsedResult.result.height;

  // Now fetch blocks starting from the latest height
  const nodeUrl = await NodeUrl.create(STAGENET_URL);
  const blocks = await nodeUrl.getBlocksBin({ start_height: startHeight - 1 });
  await sleep(5000);
  // Add assertions here if needed
  console.log(`Fetched blocks starting from height ${startHeight}`);
});
