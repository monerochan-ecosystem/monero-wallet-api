import { type ScanResult } from "../scanning-syncing/scanresult/scanResult";
export { type ScanResult };
export { NodeUrl } from "../node-interaction/nodeUrl";
import {
  getBlocksBinScan,
  getBlocksBinExecuteRequest,
  getBlocksBinScanResponse,
  type GetBlocksBinMetaCallback,
  type GetBlocksBinRequest,
  MAINNET_GENESIS_BLOCK_HASH,
  STAGENET_GENESIS_BLOCK_HASH,
} from "../node-interaction/binaryEndpoints";
import {
  scanWithCache,
  scanWithCacheFile,
  type CacheChangedCallback,
  type ScanCache,
  type ScanParams,
} from "../scanning-syncing/scanresult/scanWithCache";
import {
  makeTransaction,
  type MakeTransactionParams,
  type UnsignedTransaction,
} from "../send-functionality/transactionBuilding";
import { WasmProcessor } from "../wasm-processing/wasmProcessor";
import type { ConnectionStatus } from "../scanning-syncing/connectionStatus";
import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";
import {
  get_block_headers_range,
  get_info,
  type GetBlockHeadersRangeParams,
} from "../api";
export type NETWORKS = "mainnet" | "stagenet" | "testnet";
/**
 * This class is useful to interact with Moneros DaemonRpc binary requests in a convenient way.
 * (similar to how you would interact with a REST api that gives you json back.)
 * The wasm part will handle the creation of the binary requests and parse the responses and then parse them
 * and return outputs that belong to the ViewPair.
 * {@link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin}
 */
export class ViewPair extends WasmProcessor {
  private _network: NETWORKS | undefined;
  get network(): NETWORKS {
    return this._network as NETWORKS; // we set this in ViewPair.create()
  }
  private _genesis_hash: string | undefined;
  get genesis_hash(): string {
    if (!this._genesis_hash) {
      throw new Error("Genesis hash not set. Node not connected?");
    }
    return this._genesis_hash; // set in first call to ViewPair.getBlocksBin, if params.block_ids is supplied
  }
  protected constructor(
    public node_url: string,
    public primary_address: string,
    public fallback_node_urls: string[] = [],
    public connection_status: ConnectionStatus = {
      status_updates: [],
      last_packet: {
        status: "no_connection_yet",
        bytes_read: 0,
        node_url: "",
        timestamp: new Date().toISOString(),
      },
    }
  ) {
    super();
  }
  public static async create(
    primary_address: string,
    secret_view_key: string,
    node_url?: string,
    fallback_node_urls?: string[]
  ): Promise<ViewPair> {
    const viewPair = new ViewPair(
      node_url || LOCAL_NODE_DEFAULT_URL,
      primary_address,
      fallback_node_urls
    );
    const tinywasi = await viewPair.initWasmModule();
    viewPair.writeToWasmMemory = (ptr, len) => {
      viewPair.writeString(ptr, len, primary_address);
      viewPair.writeToWasmMemory = (ptr, len) => {
        viewPair.writeString(ptr, len, secret_view_key);
      };
    };
    let init_viewpair_result: { network: NETWORKS } | undefined = undefined;
    viewPair.readFromWasmMemory = (ptr, len) => {
      init_viewpair_result = JSON.parse(viewPair.readString(ptr, len));
    };
    //@ts-ignore
    tinywasi.instance.exports.init_viewpair(
      primary_address.length,
      secret_view_key.length
    );
    if (!init_viewpair_result) {
      throw new Error("Failed to init viewpair");
    } else {
      //@ts-ignore
      viewPair._network = init_viewpair_result.network;
    }
    return viewPair;
  }
  /**
   * This function helps with making requests to the get_blocks.bin endpoint of the Monerod nodes. It does the Request and returns the outputs that belong to the ViewPair.
   * (if outputs are found in the blocks that are returned)
   *
   * if params.block_ids is supplied, it will add the genesis hash to the end of the block_ids array.
   * (so you can just supply the block_id you want to start fetching from)
   * @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin
   * @param params params that will be turned into epee (monero lib that does binary serialization)
   * @param metaCallBack contains meta information about the getBlocksbin call (new sync height = start_height param + number of blocks)
   * @param stopSync optional AbortSignal to stop the syncing process
   * @returns The difference to the same method on NodeUrl is: It returns {@link ScanResult} (outputs that belong to viewpair) and not just the blocks as json.
   */
  public async getBlocksBin(
    params: GetBlocksBinRequest,
    metaCallBack?: GetBlocksBinMetaCallback,
    stopSync?: AbortSignal
  ) {
    return await getBlocksBinScan(
      this,
      await this.addGenesisHashToBlockIds(params),
      metaCallBack,
      stopSync
    );
  }
  async addGenesisHashToBlockIds(params: GetBlocksBinRequest) {
    if (params.block_ids) {
      if (!this._genesis_hash && this.network === "mainnet") {
        this._genesis_hash = MAINNET_GENESIS_BLOCK_HASH;
      }
      if (!this._genesis_hash && this.network === "stagenet") {
        this._genesis_hash = STAGENET_GENESIS_BLOCK_HASH;
      }

      if (!this._genesis_hash) {
        // TESTNET
        const range = await this.getBlockHeadersRange({
          start_height: 0,
          end_height: 0,
        });
        this._genesis_hash = range.headers[0].hash;
      }
      params.block_ids.push(this.genesis_hash);
    }
    return params;
  }
  /**
   * This function helps with making requests to the get_blocks.bin endpoint of the Monerod nodes.
   * if params.block_ids is supplied, it will add the genesis hash to the end of the block_ids array.
   * (so you can just supply the block_id you want to start fetching from)
   *
   * The difference compared to the getBlocksBin method is that it returns a Uint8Array that still has to be scanned for outputs.
   * This is useful if you want to scan multiple viewpairs at once. You can take the Uint8Array and pass it to another ViewPair to scan for outputs.
   * @param params params that will be turned into epee (monero lib that does binary serialization)
   * @param stopSync optional AbortSignal to stop the syncing process
   * @returns This method will return a Uint8Array that can subsequently be scanned for outputs with the getBlocksBinScanResponse method.
   */
  public async getBlocksBinExecuteRequest(
    params: GetBlocksBinRequest,
    stopSync?: AbortSignal
  ) {
    return await getBlocksBinExecuteRequest(
      this,
      await this.addGenesisHashToBlockIds(params),
      stopSync
    );
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
   * Scans blockchain from `start_height` using the provided initialCache, invoking callback cacheChanged() for results and cache changes.
   *
   * @param scan_params.start_height - Starting block height for the scan
   * @param scan_params.cacheChanged - params: {newCache,changed_outputs,connection_status} {@link CacheChangedCallback} invoked when cache changes {@link CacheChangedCallbackParameters}
   * @param scan_params.stopSync - Optional abort signal to stop scanning
   * @param scan_params.spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
   * @param initialCache - (optional) initial scan cache to start syncing from
   */
  public scanWithCache(scan_params: ScanParams, initialCache?: ScanCache) {
    return scanWithCache(this, scan_params, initialCache);
  }
  /**
   * Scans blockchain from `start_height` using the provided processor and using the provided initialCachePath file path,
   *  invoking callback cacheChanged() for results and cache changes
   *
   * @param processor - Wasm processor with scan method and primary address (like ViewPair)
   * @param initialCachePath: string - Optional initial scan cache file path. (will get created if it does not exist)
   * @param scan_params.start_height - Starting block height for the scan
   * @param scan_params.cacheChanged - params: {newCache,changed_outputs,connection_status} {@link CacheChangedCallback} invoked when cache changes {@link CacheChangedCallbackParameters}
   * @param scan_params.stopSync - Optional abort signal to stop scanning
   * @param scan_params.spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
   */
  public scanWithCacheFile(initialCachePath: string, scan_params: ScanParams) {
    return scanWithCacheFile(this, initialCachePath, scan_params);
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
   * Creates a signable transaction using the provided parameters.
   * @param params - The transaction parameters.
   * @returns The serialized transaction as an array of numbers.
   */
  public makeTransaction(params: MakeTransactionParams): UnsignedTransaction {
    return makeTransaction(this, params);
  }
  /**
   * Retrieve block headers for a specified range of heights.
   * @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_block_headers_range
   * @param params The parameters including start_height, end_height, and optional fill_pow_hash.
   * @returns The result object with headers, status, etc. Throws if the range is invalid:(end_height > daemonheight)
   */
  public async getBlockHeadersRange(params: GetBlockHeadersRangeParams) {
    return await get_block_headers_range(this.node_url, params);
  }
  /**
   * Fetch general information about the Monero daemon.
   * @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_info
   * @returns The result object with daemon info like height, status, etc.
   */
  public async getInfo() {
    return get_info(this.node_url);
  }
}
