import type { WasmProcessor } from "../wasm-processing/wasmProcessor";
export type GetBlocksBinRequest = {
  requested_info?: "BLOCKS_ONLY" | "BLOCKS_AND_POOL" | "POOL_ONLY"; // default: "BLOCKS_ONLY"
  start_height: number;
  prune?: boolean; // default: true
  no_miner_tx?: boolean; // default: false
  pool_info_since?: number; // default: 0
};
export async function getBlocksBin<T extends WasmProcessor>(
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
  let prune_num = 0;
  if (params.prune) {
    prune_num = 1;
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

  const response = await fetch(processor.node_url + "/getblocks.bin", {
    body: getBlocksArray!, // written in build_getblocksbin_request call to readFromWasmMemory
    method: "POST",
  })
    .then((result) => result.blob())
    .then((blob) => blob.arrayBuffer());
  const getBlocksBinResponseBuffer = new Uint8Array(response);
  processor.writeToWasmMemory = (ptr, len) => {
    processor.writeArray(ptr, len, getBlocksBinResponseBuffer);
  };
  //@ts-ignore
  processor.tinywasi.instance.exports.parse_response(
    getBlocksBinResponseBuffer.length
  );
}
