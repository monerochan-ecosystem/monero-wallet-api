import "./io/indexedDB";
import { type ScanResult } from "./scanning-syncing/scanResult";
export { type ScanResult };
export { NodeUrl } from "./node-interaction/nodeUrl";
import {
  getBlocksBinScan,
  getBlocksBinExecuteRequest,
  getBlocksBinScanResponse,
  type ErrorResponse,
  type GetBlocksBinMetaCallback,
  type GetBlocksBinRequest,
  type GetBlocksResultMeta,
} from "./node-interaction/binaryEndpoints";
import {
  scanWithCache,
  scanWithCacheFile,
  type CacheChangedCallback,
  type ScanCache,
} from "./scanning-syncing/scanWithCache";
import {
  makeTransaction,
  type MakeTransactionParams,
  type UnsignedTransaction,
  signTransaction,
} from "./send-functionality/transactionBuilding";
import { WasmProcessor } from "./wasm-processing/wasmProcessor";
import type { ConnectionStatus } from "./scanning-syncing/connectionStatus";
export * from "./node-interaction/binaryEndpoints";
export * from "./node-interaction/jsonEndpoints";
export {
  writeScanSettings,
  readScanSettings,
} from "./scanning-syncing/scanSettings";
export type EmptyScanResult = {}; // can happen when we abort a scan before any blocks are processed

export type FastForward = number; // height to fast forward scan to
export type ScanResultCallback =
  | ((
      result: ScanResult | ErrorResponse | EmptyScanResult
    ) => FastForward | void)
  | ((
      result: ScanResult | ErrorResponse | EmptyScanResult
    ) => Promise<FastForward | void>); // accept async callbacks
// we will await async callbacks. convenient way to halt a sync + feed back the key image list,
// to look out for our own spends before proceeding the scan. This happens in the scanWithCache function.

/**
 * This class is useful to interact with Moneros DaemonRpc binary requests in a convenient way.
 * (similar to how you would interact with a REST api that gives you json back.)
 * The wasm part will handle the creation of the binary requests and parse the responses and then parse them
 * and return outputs that belong to the ViewPair.
 * {@link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin}
 */
export class ViewPair extends WasmProcessor {
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
      node_url || "http://localhost:38081",
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
   * @param stopSync optional AbortSignal to stop the syncing process
   * @returns The difference to the same method on NodeUrl is: It returns {@link ScanResult} (outputs that belong to viewpair) and not just the blocks as json.
   */
  public getBlocksBin(
    params: GetBlocksBinRequest,
    metaCallBack?: GetBlocksBinMetaCallback,
    stopSync?: AbortSignal
  ) {
    return getBlocksBinScan(this, params, metaCallBack, stopSync);
  }
  /**
   * This function helps with making requests to the get_blocks.bin endpoint of the Monerod nodes.
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
    return await getBlocksBinExecuteRequest(this, params, stopSync);
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
   * @param callback this function will get the new outputs as they are found as a parameter,
   *  if returned value fastForward is larger than latest new_height, we continue scanning from there
   * @param stopSync optional AbortSignal to stop the syncing process
   * @param stop_height optional height to stop scanning at. (final new_height will be >= stop_height)
   */
  public async scan(
    start_height: number,
    callback: ScanResultCallback,
    stopSync?: AbortSignal,
    stop_height: number | undefined | null = null
  ) {
    let latest_meta: GetBlocksResultMeta = {
      new_height: start_height,
      daemon_height: start_height + 1,
      status: "",
      primary_address: "",
    };
    let fastForward = 0;
    while (latest_meta.new_height < latest_meta.daemon_height) {
      const res = await this.getBlocksBin(
        {
          start_height: Math.max(latest_meta.new_height - 1, fastForward),
        },
        (meta) => {
          latest_meta = meta;
        },
        stopSync
      );
      if (res === undefined) {
        await callback({});
      } else {
        fastForward = (await callback(res)) || 0;
      }
      if (stop_height !== null && latest_meta.new_height >= stop_height) return;
    }
  }

  /**
   * Scans blockchain from `start_height` using the provided initialCache, invoking callback cacheChanged() for results and cache changes.
   *
   * @param start_height - Starting block height for the scan
   * @param initialCache - Optional initial scan cache
   * @param cacheChanged - params: newCache, added, ownspend, reorged {@link CacheChangedCallback} invoked when cache changes
   * @param stopSync - Optional abort signal to stop scanning
   * @param spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
   * @param stop_height - Optional ending block height (null = keep scanning)
   */
  public scanWithCache(
    start_height: number,
    initialCache?: ScanCache,
    cacheChanged: CacheChangedCallback = (...args) => console.log(args),
    stopSync?: AbortSignal,
    spend_private_key?: string,
    stop_height: number | null = null
  ) {
    return scanWithCache(
      this,
      start_height,
      initialCache,
      cacheChanged,
      stopSync,
      spend_private_key,
      stop_height
    );
  }
  /**
   * Scans blockchain from `start_height` using the provided the provided initialCachePath file path,
   *  invoking callback cacheChanged() for results and cache changes
   *
   * @param start_height - Starting block height for the scan
   * @param initialCachePath: string - Optional initial scan cache file path. (will get created if it does not exist)
   * @param cacheChanged - params: newCache, added, ownspend, reorged {@link CacheChangedCallback} invoked when cache changes
   * @param stopSync - Optional abort signal to stop scanning
   * @param spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
   * @param stop_height - Optional ending block height (null = keep scanning)
   */
  public scanWithCacheFile(
    start_height: number,
    initialCachePath: string,
    cacheChanged: CacheChangedCallback = (...args) => console.log(args),
    stopSync?: AbortSignal,
    spend_private_key?: string, // if no spendkey is provided, this will be a view only sync. (no ownspend detected)
    stop_height: number | null = null
  ) {
    return scanWithCacheFile(
      this,
      start_height,
      initialCachePath,
      cacheChanged,
      stopSync,
      spend_private_key,
      stop_height
    );
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
}

export { signTransaction }; // signTransaction is defined in transactionBuilding.ts
export { computeKeyImage } from "./scanning-syncing/computeKeyImage"; // when scanning outputs,
//  compute key images for them to identify spends

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
   * @param stopSync optional AbortSignal to stop the syncing process
   * @param stop_height optional height to stop scanning at. (final new_height will be >= stop_height)
   */
  public async scan(
    start_height: number,
    callback: ScanResultCallback,
    stopSync?: AbortSignal,
    stop_height: number | null = null
  ) {
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
          firstResponse = await value.getBlocksBinExecuteRequest(
            {
              start_height: latest_meta.new_height - 1,
            },
            stopSync
          );
        }
        const res = await value.getBlocksBinScanResponse(
          firstResponse,
          (meta) => {
            latest_meta = meta;
          }
        );
        if (res === undefined) {
          await callback({});
        } else {
          await callback(res);
        }
        if (stop_height !== null && latest_meta.new_height >= stop_height)
          return;
      }
    }
  }
}
