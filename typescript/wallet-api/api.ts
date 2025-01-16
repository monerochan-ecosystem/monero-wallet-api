import {
  getBlocksBin,
  type GetBlocksBinRequest,
} from "./node-interaction/binaryEndpoints";
import { TinyWASI } from "./wasm-processing/wasi";
import { WasmProcessor } from "./wasm-processing/wasmProcessor";
export class ViewPair extends WasmProcessor {
  public static async create(
    primary_address: string,
    secret_view_key: string,
    node_url?: string
  ): Promise<NodeUrl> {
    const viewPair = new ViewPair(
      new TinyWASI(),
      node_url || "http://localhost:38081"
    );
    const tinywasi = await viewPair.initWasmModule();
    viewPair.writeToWasmMemory = (ptr, len) => {
      viewPair.writeString(ptr, len, primary_address);
      viewPair.writeToWasmMemory = (ptr, len) => {
        viewPair.writeString(ptr, len, secret_view_key);
      };
    };
    //@ts-ignore
    tinywasi.instance.exports.init_viewpair(
      primary_address.length,
      secret_view_key.length
    );
    return viewPair;
  }
  /**
   *
   */
  public getBlocksBin(params: GetBlocksBinRequest) {
    return getBlocksBin(this, params);
  }
}

export class NodeUrl extends WasmProcessor {
  public static async create(node_url?: string): Promise<NodeUrl> {
    const nodeUrl = new NodeUrl(
      new TinyWASI(),
      node_url || "http://localhost:38081"
    );
    await nodeUrl.initWasmModule();
    return nodeUrl;
  }
  /**
   *
   */
  public getBlocksBin(params: GetBlocksBinRequest) {
    return getBlocksBin(this, params);
  }
}
// const nodeurl = await NodeUrl.create("http://stagenet.community.rino.io:38081");
// nodeurl.getBlocksBin({ start_height: 1731707 });

// const viewpair = await ViewPair.create(
//   "5B5ieVKGSyfAyh68X6AFB48Gnx9diT8jPbWN6UcZHJUZVQSLRhaaHuHQz3dGuxxZDXPYgCXzrkerK3m6Q1tHoougR7VYyd9",
//   "10b9885324933ee6055b001a3ee4b70f6832b866db389ad023b51fe7e2e7ca01"
// );
