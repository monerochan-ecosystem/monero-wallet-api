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
  const nodeUrl = processor;

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

  nodeUrl.readFromWasmMemory = (ptr, len) => {
    const memory = nodeUrl.tinywasi.getMemory();
    const arri = new Uint8Array(memory.buffer, ptr, len);
    console.log(arri);
    fetch(nodeUrl.node_url + "/getblocks.bin", {
      body: arri,
      method: "POST",
    }).then((x) => {
      console.log(x);
      x.blob()
        .then((z) => {
          return z.arrayBuffer();
        })
        .then((y) => {
          const uint8Array = new Uint8Array(y);
          nodeUrl.writeToWasmMemory = (ptr, len) => {
            console.log(uint8Array);
            const view = nodeUrl.tinywasi.getDataView();
            for (let i = 0; i < uint8Array.length; i++) {
              const offset = i + ptr;
              view.setUint8(offset, uint8Array[i]);
            }
          };
          //@ts-ignore
          nodeUrl.tinywasi.instance.exports.parse_response(uint8Array.length);
        });
    });
    console.log("return from read");
  };
  //     //@ts-ignore
  //     instance.exports.build_getblocksbin_request(
  //     requested_info: u8,
  //     start_height: u64,
  //     prune_num: u8,
  //     no_miner_tx_num: u8,
  //     pool_info_since: u64,
  // )
  //@ts-ignore
  nodeUrl.tinywasi.instance.exports.build_getblocksbin_request(
    requested_info,
    BigInt(params.start_height),
    prune_num,
    no_miner_tx_num,
    BigInt(params.pool_info_since || 0)
  );
}
