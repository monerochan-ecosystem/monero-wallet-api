import type {
  ErrorResponse,
  GetBlocksBinMetaCallback,
  GetBlocksBinRequest,
  ScanResult,
} from "../../api";
import type { WasmProcessor } from "../../wasm-processing/wasmProcessor";
import type { ConnectionStatus } from "../connectionStatus";

import { atomicWrite } from "../../io/atomicWrite";
import {
  createSlaveFeeder,
  updateGetBlocksBinBuffer,
  type BlocksGenerator,
  type MasterSlaveInit,
} from "./getBlocksbinBuffer";
import {
  initScanCache,
  readCacheFile,
  type CacheChangedCallback,
  type HasGetBlockHeadersRangeMethod,
  type HasPrimaryAddress,
  type ScanCache,
} from "./scanCache";
import { processScanResult } from "./scanResult";

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
export async function scanWithCacheFile<
  T extends WasmProcessor & HasScanWithCacheMethod
>(
  processor: T,
  initialCachePath: string,
  scan_params: ScanParams,
  masterSlaveInit?: MasterSlaveInit,
  pathPrefix?: string
) {
  if (pathPrefix) initialCachePath = pathPrefix + initialCachePath;
  const suppliedCallback = scan_params.cacheChanged;
  const initialScanCache = await readCacheFile(initialCachePath);
  const cacheCallback: CacheChangedCallback = async (params) => {
    await atomicWrite(
      initialCachePath,
      JSON.stringify(params.newCache, null, 2)
    );
    if (suppliedCallback) await suppliedCallback(params);
  };
  scan_params.cacheChanged = cacheCallback;
  await processor.scanWithCache(
    scan_params,
    initialScanCache,
    masterSlaveInit,
    pathPrefix
  );
}

/**
 * Scan parameters for blockchain scanning with caching.
 *
 * @param start_height - Starting block height for the scan
 * @param initialCache - Optional initial scan cache
 * @param cacheChanged - Callback invoked when cache changes
 * @param stopSync - Optional abort signal to stop scanning
 * @param spend_private_key - Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged())
 */
export type ScanParams = {
  /** Starting block height for the scan */
  start_height: number;
  /** Callback invoked when cache changes */
  cacheChanged?: CacheChangedCallback;
  /** Optional abort signal to stop scanning */
  stopSync?: AbortSignal;
  /** Optional spend key (view-only if omitted = no ownspend will be found and supplied to cacheChanged()) */
  spend_private_key?: string;
};

/**
 * Scans blockchain from `start_height` using the provided processor and params,
 * invoking callback cacheChanged() for results and cache changes.
 *
 * @param processor - Wasm processor with scan method and primary address (like ViewPair)
 * @param params - Scanning configuration {@link ScanParams}
 * @param initialCache - (optional) initial scan cache to start syncing from
 */
export async function scanWithCache<
  T extends WasmProcessor &
    HasGetBlocksBinExecuteRequestMethod &
    HasGetBlocksBinScanResponseMethod &
    HasGetBlockHeadersRangeMethod &
    HasPrimaryAddress &
    HasConnectionStatus
>(
  processor: T,
  params: ScanParams,
  initialCache?: ScanCache,
  masterSlaveInit?: MasterSlaveInit,
  pathPrefix?: string
) {
  const {
    start_height,
    cacheChanged = (params) => console.log(params),
    stopSync,
    spend_private_key,
  } = params;
  let [cache, current_range] = await initScanCache(
    processor,
    start_height,
    initialCache
  );
  let blockGenerator: BlocksGenerator | undefined;

  if (masterSlaveInit && "foodFromMaster" in masterSlaveInit) {
    blockGenerator = createSlaveFeeder(
      current_range.end,
      masterSlaveInit.foodFromMaster,
      pathPrefix
    );
  }
  const defaultBlockGenerator: BlocksGenerator = (async function* () {
    const range = current_range;
    while (true) {
      if (stopSync?.aborted) return;
      const firstResponse = await processor.getBlocksBinExecuteRequest(
        { block_ids: range.block_hashes.map((b) => b.block_hash) },
        stopSync
      );

      yield firstResponse;
    }
  })();

  try {
    for await (const firstResponse of blockGenerator ??
      (defaultBlockGenerator as AsyncGenerator<Uint8Array>)) {
      if (!firstResponse) continue;
      console.log("primary address", processor.primary_address);
      const result = await processor.getBlocksBinScanResponse(firstResponse);
      current_range = await processScanResult(
        current_range,
        result,
        cache,
        cacheChanged,
        processor.connection_status,
        spend_private_key
      );
      await updateGetBlocksBinBuffer(
        masterSlaveInit,
        firstResponse,
        result,
        pathPrefix
      );
    }
  } catch (error) {
    await cacheChanged({
      newCache: cache,
      changed_outputs: [],
      connection_status: processor.connection_status,
    });
    handleScanError(error);
  }
}

function handleScanError(error: unknown) {
  // treat errno 0 code "ConnectionRefused" as non fatal outcome, and rethrow,
  // so that UI can be informed after catching it higher up
  if (isConnectionError(error)) {
    console.log("Scan stopped. node might be offline. Connection Refused");
    throw error;
  }
  // Treat AbortError as a normal, non-fatal outcome
  if (
    error &&
    typeof error === "object" &&
    (("name" in error && error.name === "AbortError") ||
      ("code" in error && error.code === 20))
  ) {
    console.log("Scan was aborted.");
    return;
  } else {
    console.log(
      error,
      "\n, scanWithCache in scanning-syncing/scanWithCache.ts`"
    );
    throw error;
  }
}

export function isConnectionError(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    (("code" in error && error.code === "ConnectionRefused") ||
      ("errno" in error && error.errno === 0))
  ) {
    return true;
  } else {
    false;
  }
}

export interface HasScanWithCacheMethod {
  scanWithCache: (
    params: ScanParams,
    initialCache?: ScanCache,
    masterSlaveInit?: MasterSlaveInit,
    pathPrefix?: string
  ) => Promise<void>;
}
export interface HasGetBlocksBinExecuteRequestMethod {
  getBlocksBinExecuteRequest: (
    params: GetBlocksBinRequest,
    stopSync?: AbortSignal
  ) => Promise<Uint8Array<ArrayBufferLike>>;
}

export interface HasGetBlocksBinScanResponseMethod {
  getBlocksBinScanResponse: (
    getBlocksBinResponseBuffer: Uint8Array<ArrayBufferLike>,
    metaCallBack?: GetBlocksBinMetaCallback
  ) => Promise<ScanResult | ErrorResponse | undefined>;
}

export interface HasConnectionStatus {
  connection_status: ConnectionStatus;
}
