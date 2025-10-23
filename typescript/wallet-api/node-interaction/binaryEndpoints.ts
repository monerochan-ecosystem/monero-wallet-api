import type { WasmProcessor } from "../wasm-processing/wasmProcessor";
export type GetBlocksBinRequest = {
  requested_info?: "BLOCKS_ONLY" | "BLOCKS_AND_POOL" | "POOL_ONLY"; // default: "BLOCKS_ONLY"
  start_height: number;
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
};
export type Output = {
  amount: number;
  block_height: number;
  index_in_transaction: number;
  index_on_blockchain: number;
  payment_id: number;
  stealth_address: string;
  tx_hash: string;
  primary_address: string;
  serialized: number[];
};

export type ScanResult = {
  outputs: Output[];
  new_height: number;
  primary_address: string;
};
export type ErrorResponse = {
  error: string;
};
export type GetBlocksBinMetaCallback = (meta: GetBlocksResultMeta) => void;

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
  let requested_info = 0;
  if (params.requested_info === "BLOCKS_AND_POOL") {
    requested_info = 1;
  } else if (params.requested_info === "POOL_ONLY") {
    requested_info = 2;
  }
  let prune_num = 1;
  if (params.prune === false) {
    prune_num = 0;
  }

  let no_miner_tx_num = 0;
  if (params.no_miner_tx) {
    no_miner_tx_num = 1;
  }

  let getBlocksRequestArray: Uint8Array;
  processor.readFromWasmMemory = (ptr, len) => {
    getBlocksRequestArray = processor.readArray(ptr, len);
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.build_getblocksbin_request(
    requested_info,
    BigInt(params.start_height),
    prune_num,
    no_miner_tx_num,
    BigInt(params.pool_info_since || 0)
  );
  return getBlocksRequestArray!; // written in build_getblocksbin_request call to readFromWasmMemory
}

export async function getBlocksBinExecuteRequest<T extends WasmProcessor>(
  processor: T,
  params: GetBlocksBinRequest
) {
  const getBlocksRequestArray = getBlocksBinMakeRequest(processor, params);
  const getBlocksBinResponseBuffer = await binaryFetchRequest(
    processor.node_url + "/getblocks.bin",
    getBlocksRequestArray! // written in build_getblocksbin_request call to readFromWasmMemory
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
  let result: ScanResult | ErrorResponse;
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
      }
    };
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.scan_blocks_with_get_blocks_bin(
    getBlocksBinResponseBuffer.length
  );
  return result!; //result written in scan_blocks_with_get_blocks_bin
}
export async function getBlocksBinScan<T extends WasmProcessor>(
  processor: T,
  params: GetBlocksBinRequest,
  metaCallBack?: GetBlocksBinMetaCallback
) {
  const getBlocksBinResponseBuffer = await getBlocksBinExecuteRequest(
    processor,
    params
  );
  return getBlocksBinScanResponse(
    processor,
    getBlocksBinResponseBuffer,
    metaCallBack
  );
}

export async function getBlocksBinJson<T extends WasmProcessor>(
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
  let requested_info = 0;
  if (params.requested_info === "BLOCKS_AND_POOL") {
    requested_info = 1;
  } else if (params.requested_info === "POOL_ONLY") {
    requested_info = 2;
  }
  let prune_num = 1;
  if (params.prune === false) {
    prune_num = 0;
  }

  let no_miner_tx_num = 0;
  if (params.no_miner_tx) {
    no_miner_tx_num = 1;
  }

  let getBlocksArray: Uint8Array;
  processor.readFromWasmMemory = (ptr, len) => {
    getBlocksArray = processor.readArray(ptr, len);
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.build_getblocksbin_request(
    requested_info,
    BigInt(params.start_height),
    prune_num,
    no_miner_tx_num,
    BigInt(params.pool_info_since || 0)
  );

  const getBlocksBinResponseBuffer = await binaryFetchRequest(
    processor.node_url + "/getblocks.bin",
    getBlocksArray! // written in build_getblocksbin_request call to readFromWasmMemory
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
  let getOutsArray = undefined;
  processor.readFromWasmMemory = (ptr, len) => {
    getOutsArray = processor.readArray(ptr, len);
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.build_getoutsbin_request(
    getouts_request_indices.length
  );
  if (!getOutsArray) {
    throw new Error("Failed to build get_outs.bin request");
  }
  return getOutsArray as Uint8Array; // written in build_getblocksbin_request call to readFromWasmMemory
}

export async function getOutsBinExecuteRequest<T extends WasmProcessor>(
  processor: T,
  params: GetOutsBinRequest
) {
  const getOutsRequestArray = getOutsBinMakeRequest(processor, params);
  const getOutsBinResponseBuffer = await binaryFetchRequest(
    processor.node_url + "/get_outs.bin",
    getOutsRequestArray! // written in build_getoutsbin_request call to readFromWasmMemory
  );
  return getOutsBinResponseBuffer;
}
export async function getOutsBinJson<T extends WasmProcessor>(
  processor: T,
  params: GetOutsBinRequest
) {
  const getOutsBinResponseBuffer = await getOutsBinExecuteRequest(
    processor,
    params
  );
  console.log(
    "got outsbin response, converting to json",
    getOutsBinResponseBuffer
  );
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeArray(ptr, len, getOutsBinResponseBuffer);
  };
  let result;
  processor.readFromWasmMemory = (ptr, len) => {
    console.log("reading outsbin response");
    let res = processor.readString(ptr, len);
    console.log("outsbin response string:", res);
    // result = JSON.parse(processor.readString(ptr, len));
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.convert_get_outs_bin_response_to_json(
    getOutsBinResponseBuffer.length
  );

  return result;
}

export async function binaryFetchRequest(url: string, body: Uint8Array) {
  const response = await fetch(url, {
    body: body as BodyInit,
    method: "POST",
  })
    .then((result) => result.blob())
    .then((blob) => blob.arrayBuffer());
  return new Uint8Array(response);
}
