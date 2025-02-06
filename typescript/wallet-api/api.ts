import {
  getBlocksBinJson,
  getBlocksBinScan,
  type ScanResult,
  type ErrorResponse,
  type GetBlocksBinMetaCallback,
  type GetBlocksBinRequest,
  type GetBlocksResultMeta,
} from "./node-interaction/binaryEndpoints";
import { TinyWASI } from "./wasm-processing/wasi";
import { WasmProcessor } from "./wasm-processing/wasmProcessor";
export * from "./node-interaction/binaryEndpoints";
export * from "./node-interaction/jsonEndpoints";
export type ScanResultCallback = (result: ScanResult | ErrorResponse) => void;
export class ViewPair extends WasmProcessor {
  public static async create(
    primary_address: string,
    secret_view_key: string,
    node_url?: string
  ): Promise<ViewPair> {
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
  public getBlocksBin(
    params: GetBlocksBinRequest,
    metaCallBack?: GetBlocksBinMetaCallback
  ) {
    return getBlocksBinScan(this, params, metaCallBack);
  }
  /**
   * scan
   */
  public async scan(start_height: number, callback: ScanResultCallback) {
    let latest_meta: GetBlocksResultMeta = {
      new_height: start_height,
      daemon_height: start_height + 1,
    };
    while (latest_meta.new_height < latest_meta.daemon_height) {
      const res = await this.getBlocksBin(
        { start_height: latest_meta.new_height },
        (meta) => {
          latest_meta = meta;
        }
      );
      callback(res);
    }
  }
  public makeIntegratedAddress(paymentId: number) {
    let address = "";
    this.readFromWasmMemory = (ptr, len) => {
      address = this.readString(ptr, len);
    };
    //@ts-ignore
    this.tinywasi.instance.exports.make_integrated_address(BigInt(paymentId));
    return address;
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
    return getBlocksBinJson(this, params);
  }
}
// const nodeurl = await NodeUrl.create("http://stagenet.community.rino.io:38081");
// nodeurl.getBlocksBin({ start_height: 1731707 });

// const viewpair = await ViewPair.create(
//   "5B5ieVKGSyfAyh68X6AFB48Gnx9diT8jPbWN6UcZHJUZVQSLRhaaHuHQz3dGuxxZDXPYgCXzrkerK3m6Q1tHoougR7VYyd9",
//   "10b9885324933ee6055b001a3ee4b70f6832b866db389ad023b51fe7e2e7ca01"
// );
