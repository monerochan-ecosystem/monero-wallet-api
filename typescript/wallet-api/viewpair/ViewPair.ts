import {
  processScanResult,
  type ScanResult,
} from "../scanning-syncing/scanresult/scanResult";
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
  handleScanError,
  lastRange,
  writeCacheFileDefaultLocationThrows,
  type ScanCache,
} from "../scanning-syncing/scanresult/scanCache";
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
import {
  readGetblocksBinBuffer,
  trimGetBlocksBinBuffer,
  writeGetblocksBinBuffer,
  type SlaveViewPair,
} from "../scanning-syncing/scanresult/getBlocksbinBuffer";
import {
  initScanCache,
  readCacheFileDefaultLocation,
  type CacheChangedCallback,
} from "../scanning-syncing/scanresult/scanCache";
import {
  openNonHaltedWallets,
  readWalletFromScanSettings,
  walletSettingsPlusKeys,
} from "../scanning-syncing/scanSettings";
import { sleep } from "../io/sleep";
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
    public connection_status: ConnectionStatus = {
      status_updates: [],
      last_packet: {
        status: "no_connection_yet",
        bytes_read: 0,
        node_url: "",
        timestamp: new Date().toISOString(),
      },
    },
  ) {
    super();
  }
  public static async create(
    primary_address: string,
    secret_view_key: string,
    subaddress_index = 0,
    node_url?: string,
  ): Promise<ViewPair> {
    const viewPair = new ViewPair(
      node_url || LOCAL_NODE_DEFAULT_URL,
      primary_address,
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
      secret_view_key.length,
      subaddress_index,
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
    stopSync?: AbortSignal,
  ) {
    return await getBlocksBinScan(
      this,
      await this.addGenesisHashToBlockIds(params),
      metaCallBack,
      stopSync,
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
    stopSync?: AbortSignal,
  ) {
    return await getBlocksBinExecuteRequest(
      this,
      await this.addGenesisHashToBlockIds(params),
      stopSync,
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
    metaCallBack?: GetBlocksBinMetaCallback,
  ) {
    return getBlocksBinScanResponse(
      this,
      getBlocksBinResponseBuffer,
      metaCallBack,
    );
  }
  /**
   * scan
   */
  public async scan(
    cacheChanged: CacheChangedCallback = (params) => console.log(params),
    stopSync?: AbortSignal,
    scan_settings_path?: string,
    pathPrefix?: string,
  ) {
    const processor = this;
    const nonHaltedWallets = await openNonHaltedWallets(scan_settings_path);
    const masterWalletSettings = nonHaltedWallets[0];
    if (masterWalletSettings.primary_address !== this.primary_address)
      throw new Error(
        "master wallet should be the first of the non halted wallets",
      );
    let current_range = await initScanCache(
      processor,
      masterWalletSettings.start_height,
      scan_settings_path,
      pathPrefix,
    );
    const blockGenerator = (async function* () {
      while (true) {
        if (stopSync?.aborted) return;
        const firstResponse = await processor.getBlocksBinExecuteRequest(
          { block_ids: current_range.block_hashes.map((b) => b.block_hash) },
          stopSync,
        );

        yield firstResponse;
      }
    })();

    const masterWithKeys = walletSettingsPlusKeys(masterWalletSettings);
    const slaveViewPairs: SlaveViewPair[] = [];
    if (nonHaltedWallets.length > 1) {
      for (const slaveWallet of nonHaltedWallets.slice(1)) {
        const slaveWithKeys = walletSettingsPlusKeys(slaveWallet);
        const viewpair = await ViewPair.create(
          slaveWallet.primary_address,
          slaveWithKeys.secret_view_key,
          slaveWallet.subaddress_index,
          masterWalletSettings.node_url,
        );
        slaveViewPairs.push({
          viewpair,
          current_range: await initScanCache(
            viewpair,
            masterWalletSettings.start_height,
            scan_settings_path,
            pathPrefix,
          ),
          secret_spend_key: slaveWithKeys.secret_spend_key,
        });
      }
    }

    try {
      for await (const firstResponse of blockGenerator) {
        if (!firstResponse) continue;
        await this.writeSubaddressesToScanCache(scan_settings_path, pathPrefix);
        const result = await processor.getBlocksBinScanResponse(firstResponse);
        const oldMasterCurrentRange = structuredClone(current_range);

        current_range = await processScanResult({
          current_range,
          result,
          cacheChanged,
          connection_status: processor.connection_status,
          secret_spend_key: masterWithKeys.secret_spend_key,
          pathPrefix,
        });
        if (slaveViewPairs.length > 0) {
          if (result && "block_infos" in result)
            await writeGetblocksBinBuffer(
              firstResponse,
              result.block_infos,
              pathPrefix,
            ); // feed the slaves
          for (const slave of slaveViewPairs) {
            let blocksBinItems = await readGetblocksBinBuffer(
              slave.current_range.end,
              pathPrefix,
            );
            let use_master_current_range = false;
            if (!blocksBinItems.length) {
              blocksBinItems = await readGetblocksBinBuffer(
                current_range.end, // we use the new current range end to find the blocks
                pathPrefix,
              );
              slave.current_range = structuredClone(oldMasterCurrentRange); // but we use the old master current range to scan with slaves
              use_master_current_range = true;
            }
            for (const blocksBinItem of blocksBinItems) {
              const blocksbin = new Uint8Array(
                await Bun.file(
                  `${pathPrefix ?? ""}getblocksbinbuffer/${
                    blocksBinItem.filename
                  }`,
                ).arrayBuffer(),
              );
              await slave.viewpair.writeSubaddressesToScanCache(
                scan_settings_path,
                pathPrefix,
              );

              const slaveResult =
                await slave.viewpair.getBlocksBinScanResponse(blocksbin);
              slave.current_range = await processScanResult({
                current_range: slave.current_range,
                result: slaveResult,
                cacheChanged,
                connection_status: processor.connection_status,
                secret_spend_key: slave.secret_spend_key,
                pathPrefix,
                use_master_current_range,
              });
            }
          } // scan the slaves
          await trimGetBlocksBinBuffer(nonHaltedWallets, pathPrefix);
        }
        if (
          !result ||
          (result && "block_infos" in result && result.block_infos.length === 0)
        ) {
          // we are at the tip, and there are no new blocks
          // sleep for 1 second before sending another
          // getBlocks.bin request
          //
          await sleep(1000);
        }
      }
    } catch (error) {
      handleScanError(error);

      const cache = await readCacheFileDefaultLocation(
        processor.primary_address,
        pathPrefix,
      );
      if (!cache)
        throw new Error(
          `${error} in scan() + cache not found for primary address: ${processor.primary_address} and path prefix: ${pathPrefix}`,
        );
      await cacheChanged({
        newCache: cache,
        changed_outputs: [],
        connection_status: processor.connection_status,
      });
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
   * This method makes a Subaddress for the Address of the Viewpair it was opened with.
   * The network (mainnet, stagenet, testnet) is the same as the one of the Viewpairaddress.
   * if there is an active scan going on, call this on ScanCacheOpened, so the new subaddress will be scanned
   *
   * @param minor address index, we always set major (also called account index) to 0
   * @returns Adressstring
   */
  public makeSubaddress(minor: number) {
    return this.makeSubaddressRaw(0, minor);
  }
  private async writeSubaddressesToScanCache(
    scan_settings_path?: string,
    pathPrefix?: string,
  ) {
    await writeCacheFileDefaultLocationThrows({
      primary_address: this.primary_address,
      pathPrefix: pathPrefix,
      writeCallback: async (cache) => {
        await this.addSubaddressesToScanCache(cache, scan_settings_path);
      },
    });
  }
  public async addSubaddressesToScanCache(
    cache: ScanCache,
    scan_settings_path?: string,
  ) {
    const walletSettings = await readWalletFromScanSettings(
      this.primary_address,
      scan_settings_path,
    );
    if (!walletSettings)
      throw new Error(
        `wallet not found in settings. did you call openwallet with the right params?
          Either wrong file name supplied to params.scan_settings_path: ${scan_settings_path}
          Or wrong primary_address supplied params.primary_address: ${this.primary_address}`,
      );
    const last_subaddress_index = walletSettings.subaddress_index || 1;
    if (!cache.subaddresses) cache.subaddresses = [];
    const highestMinor = Math.max(
      ...cache.subaddresses.map((sub) => sub.minor),
    );
    let minor = highestMinor + 1;
    while (minor <= last_subaddress_index) {
      const subaddress = this.makeSubaddress(minor);

      const created_at_height = lastRange(cache.scanned_ranges)?.end || 0;
      const created_at_timestamp = new Date().getTime();
      cache.subaddresses.push({
        minor,
        address: subaddress,
        created_at_height,
        created_at_timestamp,
      });
      minor++;
    }
  }
  /**
   * This method makes a Subaddress for the Address of the Viewpair it was opened with.
   * The network (mainnet, stagenet, testnet) is the same as the one of the Viewpairaddress.
   *
   * @param major account index should be set to 0 in most cases
   * @param minor address index
   * @returns Adressstring
   */
  private makeSubaddressRaw(major: number, minor: number) {
    let address = "";
    this.readFromWasmMemory = (ptr, len) => {
      address = this.readString(ptr, len);
    };
    //@ts-ignore
    this.tinywasi.instance.exports.make_subaddress(major, minor);
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
