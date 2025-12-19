import { ViewPair } from "../api";
import { startWebworker } from "./backgroundWorker";
import { spendable } from "./scanResult";
import {
  readWalletFromScanSettings,
  walletSettingsPlusKeys,
  writeWalletToScanSettings,
  type ScanSetting,
} from "./scanSettings";
import {
  readCacheFile,
  type CacheChangedCallback,
  type CacheChangedCallbackParameters,
  type ScanCache,
} from "./scanWithCache";
import { workerMainCode } from "./worker-entrypoints/worker";
export type ScanCacheOpenedCreateParams = {
  primary_address: string;
  start_height?: number;
  node_url?: string;
  stop_height?: number | null;
  fallback_node_urls?: string[];
  cache: ScanCache | string | true;
  halted?: boolean;
  scan_settings_path?: string; // Default: SCAN_SETTINGS_STORE_NAME_DEFAULT = "ScanSettings.json"
  write_scan_settings?: boolean; // Default: true, except if cache path or object is passed (TODO: & not in an extension)
  secret_view_key?: string;
  secret_spend_key?: string;
};
export async function loadCacheAndScanSettings(
  params: ScanCacheOpenedCreateParams
): Promise<[ScanCache | undefined, ScanSetting]> {
  let theCatchToBeOpened: ScanCache | undefined = undefined;
  // default case:  only primary_address is passed
  if (params.cache === true) {
    // 1. load cache
    const scanCache = await readCacheFile(
      `${params.primary_address}_cache.json`
    );
    theCatchToBeOpened = scanCache;

    // 2. read scan settings
    const loadedWalletSettings = await readWalletFromScanSettings(
      params.primary_address,
      params.scan_settings_path
    );
    const start_height =
      params.start_height || loadedWalletSettings?.start_height;
    if (!start_height)
      throw new Error("start_height not found in settings, or in params");
    const halted =
      typeof params.halted === "boolean"
        ? params.halted
        : loadedWalletSettings?.halted;

    // 3. merge params and walletsettings
    const walletSettings: ScanSetting = {
      primary_address: params.primary_address,
      start_height,
      halted,
      stop_height: params.stop_height || loadedWalletSettings?.stop_height,
      node_url: params.node_url || loadedWalletSettings?.node_url,
    };
    // 4. write scan settings (persist params)
    if (params.write_scan_settings)
      await writeWalletToScanSettings(walletSettings);
    return [theCatchToBeOpened, walletSettings];

    // case:  cache file path is passed, we don't use scan settings
  } else if (typeof params.cache === "string") {
    // open file
    const scanCache = await readCacheFile(params.cache);
    theCatchToBeOpened = scanCache;

    // case:  cache object is passed, we don't use scan settings
  } else if (params.cache) {
    theCatchToBeOpened = params.cache;
  }

  if (!params.start_height) throw new Error("start_height not found in params");
  const walletSettings: ScanSetting = {
    primary_address: params.primary_address,
    start_height: params.start_height,
    halted: params.halted,
    stop_height: params.stop_height,
    node_url: params.node_url,
  };
  return [theCatchToBeOpened, walletSettings];
}
export class ScanCacheOpened {
  public static async create(params: ScanCacheOpenedCreateParams) {
    const [theCatchToBeOpened, walletSettings] = await loadCacheAndScanSettings(
      params
    );

    // read secret_view_key and secret_spend_key from env
    const walletSettingsWithKeys = walletSettingsPlusKeys(
      walletSettings,
      params.secret_view_key,
      params.secret_spend_key
    );

    // create viewpair + ScanCacheOpened instance
    const scanCacheOpen = new ScanCacheOpened(
      await ViewPair.create(
        params.primary_address,
        walletSettingsWithKeys.secret_view_key,
        params.node_url
      ),
      params.write_scan_settings
    );
    if (theCatchToBeOpened) scanCacheOpen._cache = theCatchToBeOpened;

    if (!walletSettings.halted) {
      // run webworker (respecting halted param + setting)
      scanCacheOpen.wallet_scan_settings = walletSettings;
      // unpause will start scanning from this.wallet_scan_settings.start_height
      await scanCacheOpen.unpause();
    }
    return scanCacheOpen;
  }

  get cache(): ScanCache {
    return this._cache;
  }

  get node_url(): string {
    return this.view_pair.node_url;
  }
  set node_url(nu: string) {
    //TODO: write to scansettings
    // and do pause unpause
    this.view_pair.node_url = nu;
  }
  /**
   * makeTransaction
   */
  public makeTransaction() {
    // TODO do this fourth
  }
  /**
   * makeStandardTransaction
   */
  public makeStandardTransaction() {
    // TODO do this last
  }
  /**
   * notify     //ChangeReason = "added" | "ownspend" | "reorged" | "burned";

   */
  //TODO PAUSE NOTIFY listner and node status / connection error
  public notify(callback: CacheChangedCallback) {
    this.notifyListeners.push(callback);
    const id = this.notifyListeners.length - 1;
    return {
      remove: () => (this.notifyListeners[id] = null),
    };
  }
  public async pause() {
    if (this.worker) this.worker.terminate();
    if (this.write_scan_settings)
      return await writeWalletToScanSettings({
        primary_address: this._cache.primary_address,
        halted: true,
      });
  }
  public async unpause(start_height?: number, node_url?: string) {
    if (!this.wallet_scan_settings)
      throw new Error(
        "no wallet_scan_settings, should be set up in ScanCacheOpened.create()"
      );
    if (start_height) this.wallet_scan_settings.start_height = start_height;
    if (node_url) this.node_url = node_url;
    const worker_script = `\n
      const scan_settings = JSON.parse('${JSON.stringify(
        this.wallet_scan_settings
      )}')
      ${workerMainCode}
      `;
    // if startheight changed, restart worker,
    // if node_url changed, restart worker (if this was the same viewpair instance in the same thread, we wouldnt have to)
    // if worker does not exist yet, start it
    // TODO: except if we are in an extension, then wire up onmessage

    if (!this.worker || start_height || node_url) {
      this.worker?.terminate();
      this.worker = startWebworker(worker_script, (x) => {
        this._cache = (x as CacheChangedCallbackParameters).newCache;
        this.feed(x as CacheChangedCallbackParameters);
      });
    }
    if (this.write_scan_settings)
      return await writeWalletToScanSettings({
        primary_address: this._cache.primary_address,
        node_url: this.node_url,
        start_height: this.wallet_scan_settings.start_height,
        halted: false,
      });
  }
  /**
   * selectInputs larger than amount, sorted from smallest to largest
   */
  public selectInputs(amount: number) {
    return Object.values(this._cache.outputs)
      .filter((output) => spendable(output) && output.amount >= amount)
      .sort((a, b) => a.amount - b.amount);
  }
  /**
   * get spendableInputs
   */
  public spendableInputs() {
    return Object.values(this._cache.outputs).filter((output) =>
      spendable(output)
    );
  }
  /**
   * feed
   */
  public feed(params: CacheChangedCallbackParameters) {
    this._cache = params.newCache;
    this.notifyListeners;
    for (const listener of this.notifyListeners) {
      if (listener) listener(params);
    }
  }
  private _cache: ScanCache = {
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    primary_address: "",
  };
  private constructor(
    public readonly view_pair: ViewPair,
    private write_scan_settings: boolean = true,
    private wallet_scan_settings?: ScanSetting,
    private worker?: Worker
  ) {}
  private notifyListeners: (CacheChangedCallback | null)[] = [];
}

export class ManyScanCachesOpened {
  /**
   * makeTransaction
   */
  public makeTransaction() {
    // TODO do this fourth
  }
  /**
   * makeStandardTransaction
   */
  public makeStandardTransaction() {
    // TODO do this last
  }
  /**
   * notify
   */
  public notify() {
    // TODO do this second
  }
  /**
   * feed
   */
  public feed() {
    // TODO do this first
  }
}
