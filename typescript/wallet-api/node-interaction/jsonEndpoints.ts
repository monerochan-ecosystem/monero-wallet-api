import { z } from "zod";

export const GetInfoResponseSchema = z.object({
  id: z.string(),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    adjusted_time: z.number(),
    alt_blocks_count: z.number(),
    block_size_limit: z.number(),
    block_size_median: z.number(),
    block_weight_limit: z.number(),
    block_weight_median: z.number(),
    bootstrap_daemon_address: z.string(),
    busy_syncing: z.boolean(),
    credits: z.number(),
    cumulative_difficulty: z.number(),
    cumulative_difficulty_top64: z.number(),
    database_size: z.number(),
    difficulty: z.number(),
    difficulty_top64: z.number(),
    free_space: z.number(),
    grey_peerlist_size: z.number(),
    height: z.number(),
    height_without_bootstrap: z.number(),
    incoming_connections_count: z.number(),
    mainnet: z.boolean(),
    nettype: z.string(),
    offline: z.boolean(),
    outgoing_connections_count: z.number(),
    restricted: z.boolean(),
    rpc_connections_count: z.number(),
    stagenet: z.boolean(),
    start_time: z.number(),
    status: z.string(),
    synchronized: z.boolean(),
    target: z.number(),
    target_height: z.number(),
    testnet: z.boolean(),
    top_block_hash: z.string(),
    top_hash: z.string(),
    tx_count: z.number(),
    tx_pool_size: z.number(),
    untrusted: z.boolean(),
    update_available: z.boolean(),
    version: z.string(),
    was_bootstrap_ever_used: z.boolean(),
    white_peerlist_size: z.number(),
    wide_cumulative_difficulty: z.string(),
    wide_difficulty: z.string(),
  }),
});

export type GetInfoResponse = z.infer<typeof GetInfoResponseSchema>;

export function parseGetInfoResponse(data: unknown): GetInfoResponse | null {
  const result = GetInfoResponseSchema.safeParse(data);

  if (result.success) {
    return result.data;
  } else {
    console.error("Validation failed:", result.error);
    return null;
  }
}

export async function get_info(NODE_URL: string) {
  const getInfoResponse = await fetch(NODE_URL + "/json_rpc", {
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

  return parsedResult.result;
}
