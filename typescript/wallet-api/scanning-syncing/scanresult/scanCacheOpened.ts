import {
  NodeUrl,
  signTransaction,
  ViewPair,
  type GetOutsResponseBuffer,
  type Output,
} from "../../api";
import {
  prepareInput,
  sumPayments,
  type Payment,
  type PreparedInput,
} from "../../send-functionality/inputSelection";
import type {
  Input,
  SendError,
} from "../../send-functionality/transactionBuilding";
import { startWebworker } from "../backgroundWorker";
import { spendable } from "./scanResult";
import {
  openScanSettingsFile,
  readPrivateSpendKeyFromEnv,
  readWalletFromScanSettings,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  walletSettingsPlusKeys,
  writeWalletToScanSettings,
  type ScanSetting,
  type ScanSettings,
} from "../scanSettings";
import {
  readCacheFile,
  readCacheFileDefaultLocation,
  type CacheChangedCallback,
  type CacheChangedCallbackParameters,
  type ScanCache,
} from "./scanCache";
import { workerMainCode } from "../worker-entrypoints/worker";
import { workerMultipleMainCode } from "../worker-entrypoints/workerMultiple";
export type MasterScanCache = {
  masterCacheChanged: CacheChangedCallback;
  scan_settings: ScanSettings;
};
export type SlaveScanCache = boolean;
export type ScanCacheOpenedCreateParams = {
  isMaster?: MasterScanCache;
  isSlave?: SlaveScanCache;
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
  pathPrefix?: string;
};
export async function loadCacheAndScanSettings(
  params: ScanCacheOpenedCreateParams
): Promise<[ScanCache | undefined, ScanSetting]> {
  let theCatchToBeOpened: ScanCache | undefined = undefined;
  // default case:  only primary_address is passed
  if (params.cache === true) {
    // 1. load cache
    const scanCache = await readCacheFileDefaultLocation(
      params.primary_address,
      params.pathPrefix
    );
    theCatchToBeOpened = scanCache;

    // 2. read scan settings
    const loadedWalletSettings = await readWalletFromScanSettings(
      params.primary_address,
      params.scan_settings_path
    );
    const start_height =
      params.start_height || loadedWalletSettings?.start_height;
    if (!(typeof start_height === "number"))
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

  if (!(typeof params.start_height === "number"))
    throw new Error(`params.start_height not found. If you pass a cache directly, you also have to pass a height:
   loading from ScanCache object or cache file directly, means we don't touch the scan settings json file.
   You have to pass a height to scan from when you pass a cache or cache file path directly to openwallet.`);
  const walletSettings: ScanSetting = {
    primary_address: params.primary_address,
    start_height: params.start_height,
    halted: params.halted,
    stop_height: params.stop_height,
    node_url: params.node_url,
  };
  return [theCatchToBeOpened, walletSettings];
}
export type CreateTransactionParams = {
  payments: Payment[];
  inputs?: Output[];
};
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
        walletSettings.node_url || params.node_url
      ),
      params.write_scan_settings,
      params.scan_settings_path,
      params.pathPrefix
    );
    if (theCatchToBeOpened) scanCacheOpen._cache = theCatchToBeOpened;
    if (params.isMaster && params.isSlave)
      throw new Error("isMaster and isSlave cannot both be set");
    if (params.isMaster) scanCacheOpen._isMaster = params.isMaster;
    if (params.isSlave) scanCacheOpen._isSlave = params.isSlave;

    if (!walletSettings.halted) {
      // run webworker (respecting halted param + setting)
      scanCacheOpen.wallet_scan_setting = walletSettings;
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
  public async sendTransaction(signedTx: string) {
    const node = await NodeUrl.create(this.node_url);
    return await node.sendRawTransaction(signedTx);
  }
  public async signTransaction(unsignedTx: string) {
    const privateSpendKey = readPrivateSpendKeyFromEnv(
      this._cache.primary_address
    );
    if (!privateSpendKey) throw new Error("privateSpendKey not found in env");
    return await signTransaction(unsignedTx, privateSpendKey);
  }
  /**
   * this function returns the unsigned transaction, throws {@link SendError}
   */
  public async makeTransaction(params: CreateTransactionParams) {
    const sum = sumPayments(params.payments);
    const node = await NodeUrl.create(this.node_url);

    const feeEstimate = await node.getFeeEstimate();
    const selectedInputs =
      params.inputs || this.selectInputs(sum, feeEstimate.fees![0]);
    if (!selectedInputs.length) throw new Error("not enough funds");
    const distibution = await node.getOutputDistribution();
    const preparedInputs: PreparedInput[] = [];
    for (const input of selectedInputs) {
      preparedInputs.push(prepareInput(node, distibution, input));
    }
    const inputs: Input[] = [];
    for (const preparedInput of preparedInputs) {
      const input = node.makeInput(
        preparedInput.input,
        preparedInput.sample.candidates,
        await preparedInput.outsResponse
      );
      inputs.push(input);
    }

    const unsignedTx = this.view_pair.makeTransaction({
      inputs,
      payments: params.payments,
      fee_response: feeEstimate,
      fee_priority: "unimportant",
    });
    return unsignedTx;
  }
  /**
   * makeStandardTransaction
   */
  public makeStandardTransaction(destination_address: string, amount: string) {
    return this.makeTransaction({
      payments: [{ address: destination_address, amount }],
    });
  }
  /**
   * notify
   *
   * ChangeReason = "added" | "ownspend" | "reorged" | "burned";
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
    if (!this.wallet_scan_setting)
      throw new Error(
        "no wallet_scan_settings, should be set up in ScanCacheOpened.create()"
      );
    if (start_height) this.wallet_scan_setting.start_height = start_height;
    if (node_url) this.node_url = node_url;
    const settingsPathLine = this.scan_settings_path
      ? `const scan_settings_path = '${this.scan_settings_path}';`
      : "const scan_settings_path = undefined;";
    const pathPrefixLine = this.pathPrefix
      ? `const pathPrefix = '${this.pathPrefix}';`
      : "const pathPrefix = undefined;";
    const worker_script = `\n
      ${settingsPathLine}
      ${pathPrefixLine}
      ${workerMainCode}
      `;

    // if startheight changed, restart worker,
    // if node_url changed, restart worker (if this was the same viewpair instance in the same thread, we wouldnt have to)
    // if worker does not exist yet, start it
    // TODO: except if we are in an extension, then wire up onmessage

    if ((!this.worker || start_height || node_url) && !this._isSlave) {
      this.worker?.terminate(); // TODO start multiple workers
      if (this._isMaster) {
        this.worker = startWebworker(worker_script, (x) => {
          this._cache = (x as CacheChangedCallbackParameters).newCache;
          this.feed(x as CacheChangedCallbackParameters);
          this._isMaster!.masterCacheChanged(
            x as CacheChangedCallbackParameters
          );
        });
      } else {
        this.worker = startWebworker(worker_script, (x) => {
          this._cache = (x as CacheChangedCallbackParameters).newCache;
          this.feed(x as CacheChangedCallbackParameters);
        });
      }
    }
    if (this.write_scan_settings)
      return await writeWalletToScanSettings({
        primary_address: this._cache.primary_address,
        node_url: this.node_url,
        start_height: this.wallet_scan_setting.start_height,
        halted: false,
      });
  }
  /**
   * selectInputs returns array of inputs, whose sum is larger than amount
   * adds approximate fee for 10kb transaction to amount if feePerByte is supplied
   */
  public selectInputs(amount: number, feePerByte?: number) {
    if (feePerByte) amount += feePerByte * 10000; // 10kb * feePerByte; for sweeping low amounts inputs[] supplied directly
    const oneInputIsEnough = this.selectOneInput(amount);
    if (oneInputIsEnough) return [oneInputIsEnough];
    return this.selectMultipleInputs(amount);
  }
  /**
   * selectOneInput larger than amount, (smallest one matching this amount)
   */
  public selectOneInput(amount: number): Output | undefined {
    return this.spendableInputs()
      .filter((output) => output.amount >= amount)
      .sort((a, b) => a.amount - b.amount)[0];
  }
  /**
   * selectMultipleInputs larger than amount, sorted from largest to smallest until total reaches amount
   */
  public selectMultipleInputs(amount: number) {
    const selected = [];
    let total = 0;

    for (const output of this.spendableInputs()) {
      selected.push(output);
      total += output.amount;
      if (total >= amount) return selected;
    }

    return [];
  }

  /**
   * get spendableInputs
   */
  public spendableInputs() {
    return Object.values(this._cache.outputs)
      .filter((output) => spendable(output))
      .sort((a, b) => b.amount - a.amount);
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
  private _isMaster: MasterScanCache | undefined = undefined;
  private _isSlave: SlaveScanCache | undefined = undefined;
  private _cache: ScanCache = {
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    primary_address: "",
  };
  private constructor(
    public readonly view_pair: ViewPair,
    private write_scan_settings: boolean = true,
    private scan_settings_path?: string,
    private pathPrefix?: string,
    private wallet_scan_setting?: ScanSetting,
    private worker?: Worker
  ) {}
  private notifyListeners: (CacheChangedCallback | null)[] = [];
}

export class ManyScanCachesOpened {
  public static async create(scan_settings_path?: string, pathPrefix?: string) {
    const scan_settings = await openScanSettingsFile(scan_settings_path);
    if (!scan_settings?.wallets)
      throw new Error(
        `no wallets in settings file. Did you supply the right path?
     are there wallets in the default '${SCAN_SETTINGS_STORE_NAME_DEFAULT}' file?`
      );
    const nonHaltedWallets = scan_settings.wallets.filter(
      (wallet) => !wallet?.halted
    );
    if (!nonHaltedWallets.length) return undefined;
    const openedWallets: ScanCacheOpened[] = [];

    if (nonHaltedWallets.length > 1) {
      const slaveWallets: ScanCacheOpened[] = [];
      for (const wallet of nonHaltedWallets.slice(1)) {
        if (!wallet || wallet.halted) continue;
        const slaveWallet = await ScanCacheOpened.create({
          ...wallet,
          isSlave: true,
          cache: true,
          scan_settings_path,
          pathPrefix,
        });
        slaveWallets.push(slaveWallet);
      }
      const masterWallet = await ScanCacheOpened.create({
        ...nonHaltedWallets[0]!,
        isMaster: {
          masterCacheChanged: (params) => {
            for (const slave of slaveWallets) {
              if (
                slave.view_pair.primary_address ===
                params.newCache.primary_address
              )
                slave.feed(params);
            }
          },
          scan_settings,
        },
        cache: true,
        scan_settings_path,
        pathPrefix,
      });
      openedWallets.push(masterWallet, ...slaveWallets);
    } else {
      const onlyWallet = await ScanCacheOpened.create({
        ...nonHaltedWallets[0]!,
        cache: true,
        scan_settings_path,
        pathPrefix,
      });
      openedWallets.push(onlyWallet);
    }

    return new ManyScanCachesOpened(openedWallets);
  }
  private constructor(public readonly wallets: ScanCacheOpened[]) {}
}
