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

/**
 * Response schema for the get_output_distribution method.
 *
 * @property id - The request ID.
 * @property jsonrpc - The JSON-RPC version.
 * @property result - The result object containing:
 *   - distributions: An array of distribution objects, each with:
 *     - amount: unsigned int Same as in the request. Use 0 to get all RingCT outputs.
 *     - base: unsigned int; The total number of outputs of amount in the chain before, not including, the block at start_height.
 *     - distribution: array of unsigned int
 *     - start_height:  unsigned int; Note that this is not necessarily equal to from_height, especially for amount=0 where start_height will be no less than the height of the v4 hardfork.
 *   - status: string; General RPC error code. "OK" means everything looks good.
 */
export const GetOutputDistributionResponseSchema = z.object({
  id: z.string(),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    distributions: z.array(
      z.object({
        amount: z.number(),
        base: z.number(),
        distribution: z.array(z.number()),
        start_height: z.number(),
      })
    ),
    status: z.string(),
  }),
});
export type GetOutputDistributionResponse = z.infer<
  typeof GetOutputDistributionResponseSchema
>;

export function parseGetOutputDistributionResponse(
  data: unknown
): GetOutputDistributionResponse | null {
  const result = GetOutputDistributionResponseSchema.safeParse(data);

  if (result.success) {
    return result.data;
  } else {
    console.error("Validation failed:", result.error);
    return null;
  }
}

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
/**
 * Parameters for retrieving output distribution information.
 *
 * @property amounts - Array of unsigned integers representing cleartext amounts to look for.
 *   Use 0 to get all RingCT outputs. defaults to [0].
 * @property cumulative - (Optional) If true, the result will be cumulative. Defaults to false.
 * @property from_height - (Optional) Starting block height (inclusive) to check from. Defaults to 0.
 * @property to_height - (Optional) Ending block height (inclusive) to check up to. Set to 0 to get the entire chain after from_height. Defaults to 0.
 * @property binary - boolean; for disabling epee encoding, defaults to false.
 * @property compress - (Optional) If true, enables compression. Ignored if binary is set to false.
 */
export type GetOutputDistributionParams = {
  amounts?: number[];
  cumulative?: boolean;
  from_height?: number;
  to_height?: number;
  binary?: boolean;
  compress?: boolean;
};
export async function get_output_distribution(
  NODE_URL: string,
  params: GetOutputDistributionParams = {
    amounts: [0],
    binary: false,
    cumulative: true,
  }
) {
  const getOutputDistributionResponse = await fetch(NODE_URL + "/json_rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "0",
      method: "get_output_distribution",
      params,
    }),
  });

  if (!getOutputDistributionResponse.ok) {
    throw new Error(
      `Failed to get output distribution (for decoy sampling): ${getOutputDistributionResponse.statusText}`
    );
  }

  const getOutputDistributionResult =
    await getOutputDistributionResponse.json();

  const parsedResult = parseGetOutputDistributionResponse(
    getOutputDistributionResult
  );

  if (parsedResult === null || !parsedResult.result) {
    throw new Error(
      "Failed to receive output distribution from node (get_output_distribution result)"
    );
  }

  return parsedResult.result;
}

/**
 * Response schema for the get_fee_estimate method.
 *
 * @property id - The request ID.
 * @property jsonrpc - The JSON-RPC version.
 * @property result - The result object containing:
 *   - status: string; General RPC error code. "OK" means everything looks good.
 *   - fee: unsigned int; Base fee per byte.
 *   - fees: (Optional) Array of unsigned int; Fee estimates for priorities 1–4.
 *   - quantization_mask: unsigned int; Mask used for fee rounding.
 */
export const GetFeeEstimateResponseSchema = z.object({
  id: z.string(),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    status: z.string(),
    fee: z.number(),
    fees: z.array(z.number()).optional(),
    quantization_mask: z.number(),
  }),
});

export type GetFeeEstimateResponse = z.infer<
  typeof GetFeeEstimateResponseSchema
>;

export function parseGetFeeEstimateResponse(
  data: unknown
): GetFeeEstimateResponse | null {
  const result = GetFeeEstimateResponseSchema.safeParse(data);

  if (result.success) {
    return result.data;
  } else {
    console.error("Validation failed:", result.error);
    return null;
  }
}
export type GetFeeEstimateResult = {
  status: string;
  fee: number;
  fees?: number[];
  quantization_mask: number;
};

export async function get_fee_estimate(NODE_URL: string) {
  // GRACE_BLOCKS_FOR_FEE_ESTIMATE: u64 = 10 (0xA) accoding to monero oxide
  const GRACE_BLOCKS_FOR_FEE_ESTIMATE = 10;

  const getFeeEstimateResponse = await fetch(NODE_URL + "/json_rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "0",
      method: "get_fee_estimate",
      params: { grace_blocks: GRACE_BLOCKS_FOR_FEE_ESTIMATE },
    }),
  });

  if (!getFeeEstimateResponse.ok) {
    throw new Error(
      `Failed to get fee estimate: ${getFeeEstimateResponse.statusText}`
    );
  }

  const getFeeEstimateResult = await getFeeEstimateResponse.json();

  const parsedResult = parseGetFeeEstimateResponse(getFeeEstimateResult);

  if (parsedResult === null || !parsedResult.result) {
    throw new Error(
      "Failed to receive fee estimate from node (get_fee_estimate result)"
    );
  }

  return parsedResult.result;
}
