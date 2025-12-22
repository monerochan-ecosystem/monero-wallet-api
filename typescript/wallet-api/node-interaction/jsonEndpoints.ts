import { z } from "zod";
import type { SignedTransaction } from "../send-functionality/transactionBuilding";

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

export const SendRawTransactionResponseSchema = z.object({
  double_spend: z.boolean(), // double_spend - boolean; Transaction is a double spend (true) or not (false).
  fee_too_low: z.boolean(), // fee_too_low - boolean; Fee is too low (true) or OK (false).
  invalid_input: z.boolean(), // invalid_input - boolean; Input is invalid (true) or valid (false).
  invalid_output: z.boolean(), // invalid_output - boolean; Output is invalid (true) or valid (false).
  low_mixin: z.boolean(), // low_mixin - boolean; Mixin count is too low (true) or OK (false).
  not_rct: z.boolean().optional(), // not_rct - boolean; Transaction is a standard ring transaction (true) or a ring confidential transaction (false).
  not_relayed: z.boolean(), // not_relayed - boolean; Transaction was not relayed (true) or relayed (false).
  overspend: z.boolean(), // overspend - boolean; Transaction uses more money than available (true) or not (false).
  reason: z.string(), // reason - string; Additional information. Currently empty or "Not relayed" if transaction was accepted but not relayed.
  status: z.string(), // status - string; General RPC error code. "OK" means everything looks good. Any other value means that something went wrong.
  too_big: z.boolean(), // too_big - boolean; Transaction size is too big (true) or OK (false).
  untrusted: z.boolean(), // untrusted - boolean; States if the result is obtained using the bootstrap mode, and is therefore not trusted (true), or when the daemon is fully synced and thus handles the RPC locally (false)
});
export type SendRawTransactionResponse = z.infer<
  typeof SendRawTransactionResponseSchema
>;

export function parseSendRawTransactionResponse(
  data: unknown
): SendRawTransactionResponse | null {
  const result = SendRawTransactionResponseSchema.safeParse(data);
  if (result.success) {
    return result.data;
  } else {
    console.error("Validation failed:", result.error);
    return null;
  }
}

export async function send_raw_transaction(
  NODE_URL: string,
  tx_as_hex: SignedTransaction, // tx_as_hex - string; Full transaction information as hexadecimal string.
  do_not_relay: boolean = false // do_not_relay - (Optional) boolean; Stop relaying transaction to other nodes. Defaults to false.
) {
  const sendRawTransactionResponse = await fetch(
    NODE_URL + "/send_raw_transaction",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tx_as_hex, do_not_relay }),
    }
  );
  if (!sendRawTransactionResponse.ok) {
    throw new Error(
      `Failed to send raw transaction: ${sendRawTransactionResponse.statusText}`
    );
  }
  const sendRawTransactionResult = await sendRawTransactionResponse.json();
  const parsedResult = parseSendRawTransactionResponse(
    sendRawTransactionResult
  );
  if (parsedResult === null) {
    throw new Error(
      "Failed to receive response from node (send_raw_transaction result)"
    );
  }
  return parsedResult;
}
/**
 * Response schema for the get_block_headers_range method.
 *
 * @property id - The request ID.
 * @property jsonrpc - The JSON-RPC version.
 * @property result - The result object containing:
 * - credits: unsigned int; If payment for RPC is enabled, the number of credits available to the requesting client. Otherwise, 0.
 * - headers: array of block_header objects, each with:
 *   - block_size: unsigned int
 *   - block_weight: unsigned int
 *   - cumulative_difficulty: unsigned int
 *   - cumulative_difficulty_top64: unsigned int
 *   - depth: unsigned int
 *   - difficulty: unsigned int
 *   - difficulty_top64: unsigned int
 *   - hash: string
 *   - height: unsigned int
 *   - long_term_weight: unsigned int
 *   - major_version: unsigned int
 *   - miner_tx_hash: string
 *   - minor_version: unsigned int
 *   - nonce: unsigned int
 *   - num_txes: unsigned int
 *   - orphan_status: boolean
 *   - pow_hash: string (if fill_pow_hash is true)
 *   - prev_hash: string
 *   - reward: unsigned int
 *   - timestamp: unsigned int
 *   - wide_cumulative_difficulty: string
 *   - wide_difficulty: string
 * - status: string; General RPC error code. "OK" means everything looks good.
 * - top_hash: string; If payment for RPC is enabled, the hash of the highest block in the chain. Otherwise, empty.
 * - untrusted: boolean; States if the result is obtained using the bootstrap mode (true) or not (false).
 * @property error - Optional error object if the request failed:
 * - code: int; Error code.
 * - message: string; Error message.
 */
export const GetBlockHeadersRangeResponseSchema = z.object({
  id: z.string(),
  jsonrpc: z.literal("2.0"),
  result: z
    .object({
      credits: z.number(),
      headers: z.array(
        z.object({
          block_size: z.number(),
          block_weight: z.number(),
          cumulative_difficulty: z.number(),
          cumulative_difficulty_top64: z.number(),
          depth: z.number(),
          difficulty: z.number(),
          difficulty_top64: z.number(),
          hash: z.string(),
          height: z.number(),
          long_term_weight: z.number(),
          major_version: z.number(),
          miner_tx_hash: z.string(),
          minor_version: z.number(),
          nonce: z.number(),
          num_txes: z.number(),
          orphan_status: z.boolean(),
          pow_hash: z.string(),
          prev_hash: z.string(),
          reward: z.number(),
          timestamp: z.number(),
          wide_cumulative_difficulty: z.string(),
          wide_difficulty: z.string(),
        })
      ),
      status: z.string(),
      top_hash: z.string(),
      untrusted: z.boolean(),
    })
    .optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});

export type GetBlockHeadersRangeResponse = z.infer<
  typeof GetBlockHeadersRangeResponseSchema
>;

export function parseGetBlockHeadersRangeResponse(
  data: unknown
): GetBlockHeadersRangeResponse | null {
  const result = GetBlockHeadersRangeResponseSchema.safeParse(data);
  if (result.success) {
    return result.data;
  } else {
    console.error("Validation failed:", result.error);
    return null;
  }
}

/**
 * Parameters for retrieving block headers in a range.
 *
 * @property start_height - unsigned int; The starting block's height.
 * @property end_height - unsigned int; The ending block's height.
 * @property fill_pow_hash - (Optional) boolean; Add PoW hash to block_header response. Defaults to false.
 */
export type GetBlockHeadersRangeParams = {
  start_height: number;
  end_height: number;
  fill_pow_hash?: boolean;
};
export const RESTRICTED_BLOCK_HEADER_RANGE = 1000;
export async function get_block_headers_range(
  NODE_URL: string,
  params: GetBlockHeadersRangeParams
) {
  //https://github.com/monero-project/monero/blob/48ad374b0d6d6e045128729534dc2508e6999afe/src/rpc/core_rpc_server.cpp#L74
  // #define RESTRICTED_BLOCK_HEADER_RANGE 1000
  // https://github.com/monero-project/monero/blob/48ad374b0d6d6e045128729534dc2508e6999afe/src/rpc/core_rpc_server.cpp#L2612
  if (params.end_height - params.start_height > RESTRICTED_BLOCK_HEADER_RANGE) {
    throw new Error(
      "Too many block headers requested. Max: " + RESTRICTED_BLOCK_HEADER_RANGE
    );
  }
  const getBlockHeadersRangeResponse = await fetch(NODE_URL + "/json_rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "0",
      method: "get_block_headers_range",
      params,
    }),
  });
  if (!getBlockHeadersRangeResponse.ok) {
    throw new Error(
      `Failed to get block headers range: ${getBlockHeadersRangeResponse.statusText}`
    );
  }
  const getBlockHeadersRangeResult = await getBlockHeadersRangeResponse.json();
  const parsedResult = parseGetBlockHeadersRangeResponse(
    getBlockHeadersRangeResult
  );
  if (parsedResult === null) {
    throw new Error("Failed to parse block headers range response from node");
  }
  if (parsedResult.error) {
    throw new Error(
      `RPC error: ${parsedResult.error.message} (code: ${parsedResult.error.code})`
    );
  }
  if (!parsedResult.result) {
    throw new Error(
      "Failed to receive block headers range from node (missing result)"
    );
  }
  return parsedResult.result;
}
