import type { ScanResult } from "../scanning-syncing/scanresult/scanResult";
import type { WasmProcessor } from "../wasm-processing/wasmProcessor";
export type GetBlocksBinRequest = {
  requested_info?: "BLOCKS_ONLY" | "BLOCKS_AND_POOL" | "POOL_ONLY" | number; // default: "BLOCKS_ONLY"
  block_ids?: string[];
  start_height?: number;
  prune?: boolean; // default: true
  no_miner_tx?: boolean; // default: false
  pool_info_since?: number; // default: 0
};
// struct SampleCandidatesJson {
//   output_being_spent_index: u64,
//   distribution: Vec<u64>,
//   candidates_len: usize,
// }
/**
 * array of output indices to fetch
 */
export type GetOutsBinRequest = number[];
export type PoolInfo = {};
export type Transaction = {};
export type Block = {
  pruned: boolean;
  block: number[];
  block_weight: number;
  txs: "None" | Transaction[];
};

export type OutputIndex = {
  indices: {
    indices: number[];
  }[];
};

export type GetBlocksBinResponse = {
  status: "OK";
  untrusted: false;
  credits: number;
  top_hash: string;
  blocks: Block[];
  start_height: number;
  current_height: number;
  output_indices: OutputIndex[];
  daemon_time: number;
  pool_info: "None" | PoolInfo;
  new_height: number; //get_blocks_bin.start_height + get_blocks_bin.blocks.len() aka new start_height to fetch
};
export type GetOutsBinResponse = {
  status: "OK";
  untrusted: boolean;
  credits: number;
  top_hash: string;
  outs: Array<{
    key: number[];
    mask: number[];
    unlocked: boolean;
    height: number;
    txid: number[];
  }>;
};
export type Status =
  | "OK"
  | "BUSY"
  | "NOT MINING"
  | "PAYMENT REQUIRED"
  | "Failed." // there are other variations of this. depend on ! === "OK" instead
  | string;
export type GetBlocksResultMeta = {
  new_height: number;
  daemon_height: number;
  status: Status;
  primary_address:
    | "parsing-monerod-response-without-wallet"
    | "error-address-not-set"
    | string;
  block_infos: BlockInfo[];
};
export type BlockInfo = {
  block_timestamp: number;
  block_height: number;
  block_hash: string;
};

export type Output = {
  amount: number;
  block_height: number;
  index_in_transaction: number;
  index_on_blockchain: number;
  payment_id: number;
  stealth_address: string;
  tx_hash: string;
  is_miner_tx: boolean;
  primary_address: string;
  serialized: string;
  spent_relative_index?: number; // processScanResult sets this to relative index in the tx it was spent in
  spent_in_tx_hash?: string; // processScanResult will set this, if detected as ownspend (transaction)
  spent_block_height?: number; // processScanResult sets this to height, where it was detected as ownspend
  spent_block_timestamp?: number; // processScanResult sets this to timestamp, where it was detected as ownspend
  burned?: number; // index of the earlier output, that lives, while this one got burned. https://monerochan.news/article/8
};

export type ErrorResponse = {
  error: string;
};

interface HasNodeUrl {
  node_url: string;
}
export type GetBlocksBinMetaCallback = (meta: GetBlocksResultMeta) => void;
export const MAINNET_GENESIS_BLOCK_HASH =
  "418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3";
export const STAGENET_GENESIS_BLOCK_HASH =
  "76ee3cc98646292206cd3e86f74d88b4dcc1d937088645e9b0cbca84b7ce74eb";
/**
 *  This function creates a binary request to the get_blocks.bin endpoint of the Monerod node.
 * @param processor it uses the wasm module to build the request and parse the response.
 * @param params params that will be turned into epee (moner lib that does binary serialization)
 * @returns a Uint8Array that can be used to make a fetch request to the get_blocks.bin endpoint.
 */
export function getBlocksBinMakeRequest<T extends WasmProcessor>(
  processor: T,
  params: GetBlocksBinRequest
) {
  // https://github.com/monero-project/monero/blob/941ecefab21db382e88065c16659864cb8e763ae/src/rpc/core_rpc_server_commands_defs.h#L178
  //    enum REQUESTED_INFO
  //   {
  //     BLOCKS_ONLY = 0,
  //     BLOCKS_AND_POOL = 1,
  //     POOL_ONLY = 2
  //   };
  if (params.requested_info === "BLOCKS_AND_POOL") {
    params.requested_info = 1;
  } else if (params.requested_info === "POOL_ONLY") {
    params.requested_info = 2;
  } else {
    params.requested_info = 0;
  }
  if (params.prune === undefined) params.prune = true; // prune default true, our scan function expects pruned transactions

  const json_params = JSON.stringify(params);
  let getBlocksRequestArray: Uint8Array;
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeString(ptr, len, json_params);
  };
  processor.readFromWasmMemory = (ptr, len) => {
    getBlocksRequestArray = processor.readArray(ptr, len);
  };
  let error: { error: string } | null = null;
  processor.readErrorFromWasmMemory = (ptr, len) => {
    error = JSON.parse(processor.readString(ptr, len));
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.build_getblocksbin_request(
    json_params.length
  );
  if (!getBlocksRequestArray!)
    // written in build_getblocksbin_request call to readFromWasmMemory
    throw error || new Error("failed to build get_blocks.bin request");
  return getBlocksRequestArray;
}

export async function getBlocksBinExecuteRequest<
  T extends WasmProcessor & HasNodeUrl
>(processor: T, params: GetBlocksBinRequest, stopSync?: AbortSignal) {
  const getBlocksRequestArray = getBlocksBinMakeRequest(processor, params);
  const getBlocksBinResponseBuffer = await binaryFetchRequest(
    processor.node_url + "/getblocks.bin",
    getBlocksRequestArray!, // written in build_getblocksbin_request call to readFromWasmMemory
    stopSync
  );
  return getBlocksBinResponseBuffer;
}
export async function getBlocksBinScanResponse<T extends WasmProcessor>(
  processor: T,
  getBlocksBinResponseBuffer: Uint8Array,
  metaCallBack?: GetBlocksBinMetaCallback
) {
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeArray(ptr, len, getBlocksBinResponseBuffer);
  };
  let resultMeta: GetBlocksResultMeta;
  let result: ScanResult | ErrorResponse | undefined;
  processor.readFromWasmMemory = (ptr, len) => {
    resultMeta = JSON.parse(
      processor.readString(ptr, len)
    ) as GetBlocksResultMeta;
    if (metaCallBack) metaCallBack(resultMeta);
    processor.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(processor.readString(ptr, len)) as
        | ScanResult
        | ErrorResponse;
      if (!("error" in result)) {
        result.new_height = resultMeta.new_height;
        result.primary_address = resultMeta.primary_address;
        result.block_infos = resultMeta.block_infos;
        result.daemon_height = resultMeta.daemon_height;
      }
    };
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.scan_blocks_with_get_blocks_bin(
    getBlocksBinResponseBuffer.length
  );
  return result; //result written in scan_blocks_with_get_blocks_bin
}
export async function getBlocksBinScan<T extends WasmProcessor & HasNodeUrl>(
  processor: T,
  params: GetBlocksBinRequest,
  metaCallBack?: GetBlocksBinMetaCallback,
  stopSync?: AbortSignal
) {
  const getBlocksBinResponseBuffer = await getBlocksBinExecuteRequest(
    processor,
    params,
    stopSync
  );
  return getBlocksBinScanResponse(
    processor,
    getBlocksBinResponseBuffer,
    metaCallBack
  );
}

export async function getBlocksBinJson<T extends WasmProcessor & HasNodeUrl>(
  processor: T,
  params: GetBlocksBinRequest
) {
  const getBlocksRequestArray = getBlocksBinMakeRequest(processor, params);
  const getBlocksBinResponseBuffer = await binaryFetchRequest(
    processor.node_url + "/getblocks.bin",
    getBlocksRequestArray // written in build_getblocksbin_request call to readFromWasmMemory
  );
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeArray(ptr, len, getBlocksBinResponseBuffer);
  };
  let resultMeta: GetBlocksResultMeta;
  let result: GetBlocksBinResponse | ErrorResponse;
  processor.readFromWasmMemory = (ptr, len) => {
    resultMeta = JSON.parse(
      processor.readString(ptr, len)
    ) as GetBlocksResultMeta;
    processor.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(processor.readString(ptr, len)) as
        | GetBlocksBinResponse
        | ErrorResponse;
      if (!("error" in result)) {
        result.new_height = resultMeta.new_height;
      }
    };
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.convert_get_blocks_bin_response_to_json(
    getBlocksBinResponseBuffer.length
  );
  return result!; //result written in convert_get_blocks_bin_response_to_json
}
/**
 * throws error on failure to create request
 * @param processor wasmprocessor
 * @param getouts_request_indices output indices to request
 * @returns array with epee serialized get_outs.bin request arguments
 */
export function getOutsBinMakeRequest<T extends WasmProcessor>(
  processor: T,
  getouts_request_indices: GetOutsBinRequest
) {
  let getOutsArray = undefined; // return value
  const getouts_json = JSON.stringify(getouts_request_indices); // argument
  processor.readFromWasmMemory = (ptr, len) => {
    // read result
    getOutsArray = processor.readArray(ptr, len);
  };
  processor.writeToWasmMemory = (ptr, len) => {
    // write argument
    processor.writeString(ptr, len, getouts_json);
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.build_getoutsbin_request(
    getouts_json.length
  );
  if (!getOutsArray) {
    throw new Error("Failed to build get_outs.bin request");
  }
  return getOutsArray as Uint8Array; // written in build_getblocksbin_request call to readFromWasmMemory
}
export type GetOutsResponseBuffer = Uint8Array;
export async function getOutsBinExecuteRequest<
  T extends WasmProcessor & HasNodeUrl
>(processor: T, params: GetOutsBinRequest): Promise<GetOutsResponseBuffer> {
  const getOutsRequestArray = getOutsBinMakeRequest(processor, params);
  const getOutsBinResponseBuffer = await binaryFetchRequest(
    processor.node_url + "/get_outs.bin",
    getOutsRequestArray! // written in build_getoutsbin_request call to readFromWasmMemory
  );
  return getOutsBinResponseBuffer;
}
export async function getOutsBinJson<T extends WasmProcessor & HasNodeUrl>(
  processor: T,
  params: GetOutsBinRequest
) {
  const getOutsBinResponseBuffer = await getOutsBinExecuteRequest(
    processor,
    params
  );
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeArray(ptr, len, getOutsBinResponseBuffer);
  };
  let result;
  processor.readFromWasmMemory = (ptr, len) => {
    result = JSON.parse(processor.readString(ptr, len));
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.convert_get_outs_bin_response_to_json(
    getOutsBinResponseBuffer.length
  );
  if (!result) {
    throw new Error("Failed to parse get_outs.bin response");
  }
  return result as GetOutsBinResponse;
}

export async function binaryFetchRequest(
  url: string,
  body: Uint8Array,
  stopSync?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetch(url, {
    body: body as BodyInit,
    method: "POST",
    signal: stopSync,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const MAX_SIZE = 125829120; // 120MB

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_SIZE)
        throw new Error(`Response exceeds 120MB (${totalBytes} bytes)`);
      chunks.push(value);
    }
  } catch (readError) {
    console.error("Reader error:", readError, "Partial bytes:", totalBytes);
    // Eat the error - continue to return partial data
  } finally {
    reader.releaseLock();
  }

  // Always return what we got (even if partial)
  return Uint8Array.from(
    chunks.reduce((acc: number[], chunk) => [...acc, ...chunk], [])
  );
}
