import { monero_wallet_api_wasm } from "./wasmFile";
import { TinyWASI } from "./wasi";
export type MemoryCallback = (ptr: number, len: number) => void;
class WasmProcessor {
  /**
   * This method is invoked whenever a Rust function expects an array or string parameter.
   * You should use `writeArray` or `writeString` within the function assigned to this callback
   * to write the data into WebAssembly (Wasm) memory before calling the corresponding Wasm method.
   *
   * @param ptr - The WebAssembly memory address where the data should be written.
   * @param len - The number of bytes to write starting from the specified `ptr`.
   */
  public writeToWasmMemory: MemoryCallback = (ptr: number, len: number) => {};
  /**
   * This method is invoked whenever a Rust function wants to return an array or string.
   * You should use `readArray` or `readString` within the function assigned to this callback
   * to read the data from WebAssembly (Wasm) memory after the corresponding Wasm method has written it.
   *
   * @param ptr - The WebAssembly memory address from which the data should be read.
   * @param len - The number of bytes to read starting from the specified `ptr`.
   */
  public readFromWasmMemory: MemoryCallback = (ptr: number, len: number) => {};
  /**
   * Writes an array of bytes to a specified offset in WebAssembly memory.
   *
   * This method is typically used within `writeToWasmMemory` to write data into Wasm memory.
   * For more details, see {@link writeToWasmMemory}.
   *
   * @param ptr - The WebAssembly memory address where the data should be written.
   * @param len - The number of bytes to write starting from the specified `ptr`.
   * @param arr - The array of bytes to write into WebAssembly memory.
   *
   * @see {@link writeToWasmMemory}
   */
  public writeArray = (ptr: number, len: number, arr: Uint8Array) => {
    const view = this.tinywasi.getDataView();

    for (let i = 0; i < arr.length; i++) {
      const offset = i + ptr;
      view.setUint8(offset, arr[i]);
    }
  };
  /**
   * Writes a string to a specified offset in WebAssembly memory.
   *
   * This method is typically used within `writeToWasmMemory` to write string data into Wasm memory.
   * For more details, see {@link writeToWasmMemory}.
   *
   * @param ptr - The WebAssembly memory address where the data should be written.
   * @param len - The number of bytes to write starting from the specified `ptr`.
   * @param str - The string to write into WebAssembly memory.
   *
   * @see {@link writeToWasmMemory}
   */
  public writeString = (ptr: number, len: number, str: string) => {
    const encoder = new TextEncoder();
    const arr = encoder.encode(str);
    this.writeArray(ptr, len, arr);
  };
  /**
   * Reads an array of bytes from a specified offset in WebAssembly memory.
   *
   * This method is typically used within the function assigned to `readFromWasmMemory`
   * callback to read data written by Rust functions into Wasm memory.
   *
   * @param ptr - The WebAssembly memory address from which the data should be read.
   * @param len - The number of bytes to read starting from the specified `ptr`.
   * @returns A Uint8Array containing the bytes read from WebAssembly memory.
   *
   * @see {@link readFromWasmMemory}
   */
  public readArray = (ptr: number, len: number) => {
    const memory = this.tinywasi.getMemory();
    return new Uint8Array(memory.buffer, ptr, len);
  };
  protected constructor(protected tinywasi: TinyWASI) {}
}

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
    console.log(
      requested_info,
      params.start_height,
      prune_num,
      no_miner_tx_num,
      params.pool_info_since || 0
    );

    // https://github.com/monero-project/monero/blob/941ecefab21db382e88065c16659864cb8e763ae/src/rpc/core_rpc_server.cpp#L635
    // switch (req.requested_info)
    // {
    //   case COMMAND_RPC_GET_BLOCKS_FAST::BLOCKS_ONLY:
    //     // Compatibility value 0: Clients that do not set 'requested_info' want blocks, and only blocks
    //     get_blocks = true;
    //     break;
    //   case COMMAND_RPC_GET_BLOCKS_FAST::BLOCKS_AND_POOL:
    //     get_blocks = true;
    //     get_pool = true;
    //     break;
    //   case COMMAND_RPC_GET_BLOCKS_FAST::POOL_ONLY:
    //     get_pool = true;
    //     break;
    //   default:
    //     res.status = "Failed, wrong requested info";
    //     return true;
    // }

    nodeUrl.readFromWasmMemory = (ptr, len) => {
      const memory = nodeUrl.tinywasi.getMemory();
      const arri = new Uint8Array(memory.buffer, ptr, len);
      console.log(arri);
      fetch(nodeUrl.node_url + "/getblocks.bin", {
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
const nodeurl = await NodeUrl.create("http://stagenet.community.rino.io:38081");
nodeurl.getBlocksBin({ start_height: 1731707 });

// const viewpair = await ViewPair.create(
//   "5B5ieVKGSyfAyh68X6AFB48Gnx9diT8jPbWN6UcZHJUZVQSLRhaaHuHQz3dGuxxZDXPYgCXzrkerK3m6Q1tHoougR7VYyd9",
//   "10b9885324933ee6055b001a3ee4b70f6832b866db389ad023b51fe7e2e7ca01"
// );
