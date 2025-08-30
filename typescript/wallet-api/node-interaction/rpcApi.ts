import type { FunctionCallMeta } from "../wasm-processing/wasmProcessor";

/**
 * RPC API class for handling rpc calls by the wallet library.
 * The way monero-oxide is written demands an inversion of control when building transactions.
 * If we don't want to recall certain functions multiple times (for example when picking
 * decoys), memoization and caching can be implemented here.
 */
export class RpcApi {
  constructor() {}

  /**
   * callRpc is a generic method to call any RPC method.
   */
  public callRpc(functionCallMeta: FunctionCallMeta) {
    console.log("rpc functionCall called", functionCallMeta);
    return ""; // TODO: implement actual RPC call logic
  }
}
