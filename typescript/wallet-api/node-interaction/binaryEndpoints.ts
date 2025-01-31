import type { WasmProcessor } from "../wasm-processing/wasmProcessor";
export type GetBlocksBinRequest = {
  requested_info?: "BLOCKS_ONLY" | "BLOCKS_AND_POOL" | "POOL_ONLY"; // default: "BLOCKS_ONLY"
  start_height: number;
  prune?: boolean; // default: true
  no_miner_tx?: boolean; // default: false
  pool_info_since?: number; // default: 0
};
type PoolInfo = {};
type Transaction = {};
type Block = {
  pruned: boolean;
  block: number[];
  block_weight: number;
  txs: "None" | Transaction[];
};

type OutputIndex = {
  indices: {
    indices: number[];
  }[];
};

type GetBlocksBinResponse = {
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
type GetBlocksResultMeta = {
  new_height: number;
  daemon_height: number;
};

export async function getBlocksBin<T extends WasmProcessor>(
  processor: T,
  params: GetBlocksBinRequest,
  metaCallBack?: (meta: GetBlocksResultMeta) => void
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
  let result: GetBlocksBinResponse;
  processor.readFromWasmMemory = (ptr, len) => {
    resultMeta = JSON.parse(
      processor.readString(ptr, len)
    ) as GetBlocksResultMeta;
    if (metaCallBack) metaCallBack(resultMeta);
    processor.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(
        processor.readString(ptr, len)
      ) as GetBlocksBinResponse;
      result.new_height = resultMeta.new_height;
    };
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.parse_response(
    getBlocksBinResponseBuffer.length
  );
  return result!; //result written in parse_response
}

async function binaryFetchRequest(url: string, body: Uint8Array) {
  const response = await fetch(url, {
    body,
    method: "POST",
  })
    .then((result) => result.blob())
    .then((blob) => blob.arrayBuffer());
  return new Uint8Array(response);
}
