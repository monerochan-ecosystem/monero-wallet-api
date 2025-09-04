import type { FunctionCallMeta } from "../wasm-processing/wasmProcessor";
import { get_info } from "./jsonEndpoints";

/**
 * RPC API class for handling rpc calls by the wallet library.
 * The way monero-oxide is written demands an inversion of control when building transactions.
 * If we don't want to recall certain functions multiple times (for example when picking
 * decoys), memoization and caching can be implemented here.
 */
export class RpcApi {
  constructor(public node_url: string) {}

  /**
   * callRpc is a generic method to call any RPC method.
   */
  public async callRpc(functionCallMeta: FunctionCallMeta) {
    console.log("rpc functionCall called", functionCallMeta);
    if (functionCallMeta.function === "get_output_distribution_end_height") {
      return await this.get_output_distribution_end_height();
    }
    return ""; // TODO: implement actual RPC call logic
  }
  /**
   * get_output_distribution_end_height
   */
  public async get_output_distribution_end_height() {
    console.log(" height requested", this.node_url);
    //todo call getinfo and return height
    const get_info_result = await get_info(this.node_url);
    console.log(" height requested", get_info_result, this.node_url);
    return get_info_result.height.toString();
  }
}
