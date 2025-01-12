import { monero_wallet_api_wasm } from "./wasm-processing/wasmFile";
import { TinyWASI } from "./wasm-processing/wasi";
import { WasmProcessor } from "./wasm-processing/wasmProcessor";
export class ViewPair extends WasmProcessor {
  public static async create(
    primary_address: string,
    secret_view_key: string
  ): Promise<ViewPair> {
    const viewPair = new ViewPair(
      primary_address,
      secret_view_key,
      new TinyWASI()
    );
    const tinywasi = viewPair.tinywasi;

    const imports = {
      env: {
        input: (ptr: number, len: number) => {
          console.log("input", ptr, len);
          viewPair.writeToWasmMemory(ptr, len);
        },
        output: (ptr: number, len: number) => {
          console.log("output", ptr, len);
          viewPair.readFromWasmMemory(ptr, len);
        },
      },
      ...tinywasi.imports,
    };

    const { module, instance } = await WebAssembly.instantiate(
      monero_wallet_api_wasm,
      imports
    );
    tinywasi.initialize(instance);
    console.log(instance.exports);
    viewPair.writeToWasmMemory = (ptr, len) => {
      viewPair.writeString(ptr, len, primary_address);
      viewPair.writeToWasmMemory = (ptr, len) => {
        viewPair.writeString(ptr, len, secret_view_key);
      };
    };
    viewPair.readFromWasmMemory = (ptr, len) => {
      const memory = tinywasi.getMemory();
      const arri = new Uint8Array(memory.buffer, ptr, len);
      console.log(arri);
      fetch("http://stagenet.community.rino.io:38081/getblocks.bin", {
        headers: {
          accept: "*/*",
          "accept-language": "en-US,en;q=0.9",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          Referer: "http://localhost:8080/",
          "Referrer-Policy": "strict-origin-when-cross-origin",
        },
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
            viewPair.writeToWasmMemory = (ptr, len) => {
              console.log(uint8Array);
              const view = tinywasi.getDataView();
              for (let i = 0; i < uint8Array.length; i++) {
                const offset = i + ptr;
                view.setUint8(offset, uint8Array[i]);
              }
            };
            //@ts-ignore
            instance.exports.parse_response(uint8Array.length);
          });
      });
    };
    //@ts-ignore
    instance.exports.init_viewpair(
      primary_address.length,
      secret_view_key.length
    );
    //todo attach instance to viewPair
    return viewPair;
  }

  private constructor(
    private primary_address: string,
    private secret_view_key: string,
    tinywasi: TinyWASI
  ) {
    super(tinywasi);
  }
}

export class NodeUrl extends WasmProcessor {
  public static async create(node_url: string): Promise<NodeUrl> {
    const nodeUrl = new NodeUrl(node_url, new TinyWASI());
    const tinywasi = nodeUrl.tinywasi;

    const imports = {
      env: {
        input: (ptr: number, len: number) => {
          console.log("input", ptr, len);
          nodeUrl.writeToWasmMemory(ptr, len);
        },
        output: (ptr: number, len: number) => {
          console.log("output", ptr, len);
          nodeUrl.readFromWasmMemory(ptr, len);
        },
      },
      ...tinywasi.imports,
    };

    const { module, instance } = await WebAssembly.instantiate(
      monero_wallet_api_wasm,
      imports
    );
    tinywasi.initialize(instance);
    console.log(instance.exports);
    return nodeUrl;
  }
  /**
   *
   */
  public getBlocksBin(params: GetBlocksBinRequest) {
    const nodeUrl = this;

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

  private constructor(private node_url: string, tinywasi: TinyWASI) {
    super(tinywasi);
  }
}
export type GetBlocksBinRequest = {
  requested_info?: "BLOCKS_ONLY" | "BLOCKS_AND_POOL" | "POOL_ONLY"; // default: "BLOCKS_ONLY"
  start_height: number;
  prune?: boolean; // default: true
  no_miner_tx?: boolean; // default: false
  pool_info_since?: number; // default: 0
};
// const nodeurl = await NodeUrl.create("http://stagenet.community.rino.io:38081");
// nodeurl.getBlocksBin({ start_height: 1731707 });

// const viewpair = await ViewPair.create(
//   "5B5ieVKGSyfAyh68X6AFB48Gnx9diT8jPbWN6UcZHJUZVQSLRhaaHuHQz3dGuxxZDXPYgCXzrkerK3m6Q1tHoougR7VYyd9",
//   "10b9885324933ee6055b001a3ee4b70f6832b866db389ad023b51fe7e2e7ca01"
// );

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
