import { test } from "bun:test";
import { NodeUrl } from "../wallet-api/api"; // Adjust the import path as needed
const STAGENET_URL = "http://stagenet.community.rino.io:38081";
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

  if (!getInfoResult.result?.height) {
    throw new Error("Failed to get height from get_info result");
  }
  console.log(getInfoResult);
  const startHeight = getInfoResult.result.height;

  // Now fetch blocks starting from the latest height
  const nodeUrl = await NodeUrl.create(STAGENET_URL);
  const blocks = await nodeUrl.getBlocksBin({ start_height: startHeight });

  // Add assertions here if needed
  console.log(`Fetched blocks starting from height ${startHeight}`);
});
