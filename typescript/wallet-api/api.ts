import {
  getBlocksBinJson,
  getBlocksBinScan,
  getBlocksBinExecuteRequest,
  getBlocksBinScanResponse,
  type ScanResult,
  type ErrorResponse,
  type GetBlocksBinMetaCallback,
  type GetBlocksBinRequest,
  type GetBlocksResultMeta,
  type Output,
} from "./node-interaction/binaryEndpoints";
import { makeInputs } from "./send-functionality/transactionBuilding";
import { WasmProcessor } from "./wasm-processing/wasmProcessor";
export * from "./node-interaction/binaryEndpoints";
export * from "./node-interaction/jsonEndpoints";
export type ScanResultCallback = (result: ScanResult | ErrorResponse) => void;
/**
 * This class is useful to interact with Moneros DaemonRpc binary requests in a convenient way.
 * (similar to how you would interact with a REST api that gives you json back.)
 * The wasm part will handle the creation of the binary requests and parse the responses and then parse them
 * and return outputs that belong to the ViewPair.
 * {@link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin}
 */
export class ViewPair extends WasmProcessor {
  public static async create(
    primary_address: string,
    secret_view_key: string,
    node_url?: string
  ): Promise<ViewPair> {
    const viewPair = new ViewPair(node_url || "http://localhost:38081");
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
   * This function helps with making requests to the get_blocks.bin endpoint of the Monerod nodes. It does the Request and returns the outputs that belong to the ViewPair.
   * (if outputs are found in the blocks that are returned)
   * @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin
   * @param params params that will be turned into epee (monero lib that does binary serialization)
   * @param metaCallBack contains meta information about the getBlocksbin call (new sync height = start_height param + number of blocks)
   * @returns The difference to the same method on NodeUrl is: It returns {@link ScanResult} (outputs that belong to viewpair) and not just the blocks as json.
   */
  public getBlocksBin(
    params: GetBlocksBinRequest,
    metaCallBack?: GetBlocksBinMetaCallback
  ) {
    return getBlocksBinScan(this, params, metaCallBack);
  }
  /**
   * This function helps with making requests to the get_blocks.bin endpoint of the Monerod nodes.
   * The difference compared to the getBlocksBin method is that it returns a Uint8Array that still has to be scanned for outputs.
   * This is useful if you want to scan multiple viewpairs at once. You can take the Uint8Array and pass it to another ViewPair to scan for outputs.
   * @param params params that will be turned into epee (monero lib that does binary serialization)
   * @returns This method will return a Uint8Array that can subsequently be scanned for outputs with the getBlocksBinScanResponse method.
   */
  public async getBlocksBinExecuteRequest(params: GetBlocksBinRequest) {
    return await getBlocksBinExecuteRequest(this, params);
  }
  /**
   * This function helps with scanning the response of the getBlocksBinExecuteRequest method.
   * It will parse the Uint8Array and return the outputs that belong to the ViewPair.
   * (if outputs are found in the blocks that are contained in the Uint8Array that was returned by the getBlocksBinExecuteRequest method)
   * @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin
   * @param getBlocksBinResponseBuffer the Uint8Array that was returned by the getBlocksBinExecuteRequest method.(which contains the blocks in binary format, returned from the Monerod node)
   * @param metaCallBack contains meta information about the getBlocksbin call (new sync height = start_height param + number of blocks)
   * @returns It returns {@link ScanResult} (outputs that belong to viewpair)
   */
  public getBlocksBinScanResponse(
    getBlocksBinResponseBuffer: Uint8Array,
    metaCallBack?: GetBlocksBinMetaCallback
  ) {
    return getBlocksBinScanResponse(
      this,
      getBlocksBinResponseBuffer,
      metaCallBack
    );
  }
  /**
   * This method will use getBlocks.bin from start height to daemon height.
   * This is CPU bound work, so it should be executed in a seperate thread (worker).
   * The scanner.ts worker in the standard-checkout dir shows how to keep scanning after the tip is reached.
   * It also shows how the outputs are saved (note the unqiue requirement for the stealth_adress).
   * @param start_height the height to start syncing from.
   * @param callback this function will get the new outputs as they are found as a parameter
   */
  public async scan(start_height: number, callback: ScanResultCallback) {
    let latest_meta: GetBlocksResultMeta = {
      new_height: start_height,
      daemon_height: start_height + 1,
      status: "",
      primary_address: "",
    };
    while (latest_meta.new_height < latest_meta.daemon_height) {
      const res = await this.getBlocksBin(
        {
          start_height: latest_meta.new_height - 1,
        },
        (meta) => {
          latest_meta = meta;
        }
      );
      callback(res);
    }
  }
  /**
   * This method makes an integrated Address for the Address of the Viewpair it was opened with.
   * The network (mainnet, stagenet, testnet) is the same as the one of the Viewpairaddress.
   * @param paymentId (u64 under the hood) you can use a random number or a primary key of an sqlite db to associate payments with customer sessions.
   * @returns Adressstring
   */
  public makeIntegratedAddress(paymentId: number) {
    let address = "";
    this.readFromWasmMemory = (ptr, len) => {
      address = this.readString(ptr, len);
    };
    //@ts-ignore
    this.tinywasi.instance.exports.make_integrated_address(BigInt(paymentId));
    return address;
  }
  /**
   * makeInputs
   */
  public makeInputs(outputs: Output[]) {
    return makeInputs(this, outputs);
  }
}
/**
 * This class is useful to interact with Moneros DaemonRpc binary requests in a convenient way.
 * (similar to how you would interact with a REST api that gives you json back.)
 * The wasm part will handle the creation of the binary requests and parse the responses and return them as json.
 * {@link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin}
 */
export class NodeUrl extends WasmProcessor {
  public static async create(node_url?: string): Promise<NodeUrl> {
    const nodeUrl = new NodeUrl(node_url || "http://localhost:38081");
    await nodeUrl.initWasmModule();
    return nodeUrl;
  }
  /**
   * This request helps making requests to the get_blocks.bin endpoint of the Monerod nodes.
   *  @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin
   * @param params params that will be turned into epee (moner lib that does binary serialization)
   * @returns after the request is made it will return epee serialized objects that are then parsed into json.
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

export type AddressAndViewKey = {
  primary_address: string;
  secret_view_key: string;
};
/**
 * The ViewPairs class contains a set of ViewPair objects that can be used to scan multiple addresses at once.
 * (while only retrieving the blocks from the node once)
 */
export class ViewPairs {
  private viewPairs: Map<string, ViewPair>;

  protected constructor() {
    this.viewPairs = new Map<string, ViewPair>();
  }
  public static async create(
    pairs: AddressAndViewKey[],
    node_url?: string
  ): Promise<ViewPairs> {
    const viewPairs = new ViewPairs();
    for (const element of pairs) {
      const viewPair = await ViewPair.create(
        element.primary_address,
        element.secret_view_key,
        node_url
      );
      viewPairs.viewPairs.set(element.primary_address, viewPair);
    }
    return viewPairs;
  }

  public async addViewPair(
    primary_address: string,
    secret_view_key: string,
    node_url?: string
  ): Promise<ViewPair> {
    const viewPair = await ViewPair.create(
      primary_address,
      secret_view_key,
      node_url
    );
    this.viewPairs.set(primary_address, viewPair);
    return viewPair;
  }

  public getViewPair(primary_address: string): ViewPair | undefined {
    return this.viewPairs.get(primary_address);
  }
  /**
   * This method will use getBlocks.bin from start height to daemon height.
   * This is CPU bound work, so it should be executed in a seperate thread (worker).
   * The scanner.ts worker in the standard-checkout dir shows how to keep scanning after the tip is reached.
   * It also shows how the outputs are saved (note the unqiue requirement for the stealth_adress).
   * @param start_height the height to start syncing from.
   * @param callback this function will get the new outputs as they are found as a parameter
   */
  public async scan(start_height: number, callback: ScanResultCallback) {
    let latest_meta: GetBlocksResultMeta = {
      new_height: start_height,
      daemon_height: start_height + 1,
      status: "",
      primary_address: "",
    };
    while (latest_meta.new_height < latest_meta.daemon_height) {
      let firstResponse: Uint8Array | undefined;
      for (const [key, value] of this.viewPairs) {
        if (!firstResponse) {
          firstResponse = await value.getBlocksBinExecuteRequest({
            start_height: latest_meta.new_height - 1,
          });
        }
        const res = await value.getBlocksBinScanResponse(
          firstResponse,
          (meta) => {
            latest_meta = meta;
          }
        );
        callback(res);
      }
    }
  }
}
