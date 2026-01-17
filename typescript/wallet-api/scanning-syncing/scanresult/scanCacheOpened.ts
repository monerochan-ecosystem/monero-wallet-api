import { NodeUrl, signTransaction, ViewPair, type Output } from "../../api";
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
import { createWebworker } from "../backgroundWorker";
import { spendable } from "./scanResult";
import {
  openScanSettingsFile,
  readPrivateSpendKeyFromEnv,
  readWalletFromScanSettings,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  walletSettingsPlusKeys,
  writeWalletToScanSettings,
} from "../scanSettings";
import {
  lastRange,
  readCacheFileDefaultLocation,
  type CacheChangedCallback,
  type CacheChangedCallbackParameters,
  type ScanCache,
  type Subaddress,
} from "./scanCache";

export type SlaveScanCache = boolean;
export type ScanCacheOpenedCreateParams = {
  primary_address: string;
  scan_settings_path?: string; // Default: SCAN_SETTINGS_STORE_NAME_DEFAULT = "ScanSettings.json"
  pathPrefix?: string;
  no_worker?: boolean;
  masterCacheChanged?: CacheChangedCallback;
};

export type CreateTransactionParams = {
  payments: Payment[];
  inputs?: Output[];
};
export class ScanCacheOpened {
  public static async create(params: ScanCacheOpenedCreateParams) {
    const theCatchToBeOpened = await readCacheFileDefaultLocation(
      params.primary_address,
      params.pathPrefix
    );

    const walletSettings = await readWalletFromScanSettings(
      params.primary_address,
      params.scan_settings_path
    );
    if (!walletSettings)
      throw new Error(
        `wallet not found in settings. did you call openwallet with the right params?
      Either wrong file name supplied to params.scan_settings_path: ${params.scan_settings_path}
      Or wrong primary_address supplied params.primary_address: ${params.primary_address}`
      );
    if (!params.primary_address)
      throw new Error(
        `primary_address is required, potentially half filled out wallet setting in: ${
          params.scan_settings_path || SCAN_SETTINGS_STORE_NAME_DEFAULT
        }`
      );
    // read secret_view_key and secret_spend_key from env
    const walletSettingsWithKeys = walletSettingsPlusKeys(walletSettings);

    // create viewpair + ScanCacheOpened instance
    const scanCacheOpen = new ScanCacheOpened(
      await ViewPair.create(
        params.primary_address,
        walletSettingsWithKeys.secret_view_key,
        walletSettings.subaddress_index,
        walletSettings.node_url
      ),
      params.no_worker || false,
      params.masterCacheChanged || null,
      params.scan_settings_path,
      params.pathPrefix
    );
    if (theCatchToBeOpened) scanCacheOpen._cache = theCatchToBeOpened;

    if (!walletSettings.halted) {
      // run webworker (respecting halted param + setting)
      // unpause will start scanning from this.wallet_scan_settings.start_height
      await scanCacheOpen.unpause();
    }
    return scanCacheOpen;
  }

  get cache(): ScanCache {
    return this._cache;
  }
  get primary_address(): string {
    return this.view_pair.primary_address;
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
  get subaddresses() {
    // we don't use this._cache.subaddresses directly,
    // because the cache will be written by the background worker that does the scan
    if (!this._subaddresses)
      this._subaddresses = structuredClone(this._cache.subaddresses) || [];
    return this._subaddresses;
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
   * makeIntegratedAddress
   */
  public makeIntegratedAddress(paymentId: number) {
    return this.view_pair.makeIntegratedAddress(paymentId);
  }
  /**
   * This method makes a Subaddress for the Address of the Viewpair it was opened with.
   * The network (mainnet, stagenet, testnet) is the same as the one of the Viewpairaddress.
   * will increment minor by 1 on major 0 in "ScanSettings.json" subaddresses definition
   *
   * if there is an active scan going on, call this here on ScanCacheOpened, so the new subaddress will be scanned
   * (and not on a viewpair / scancacheopened instance that is not conducting the scan, aka where no_worker is true)
   *
   * @returns Adressstring
   */
  public async makeSubaddress() {
    const walletSettings = await readWalletFromScanSettings(
      this.view_pair.primary_address,
      this.scan_settings_path
    );
    if (!walletSettings)
      throw new Error(
        `wallet not found in settings. did you call openwallet with the right params?
      Either wrong file name supplied to params.scan_settings_path: ${this.scan_settings_path}
      Or wrong primary_address supplied params.primary_address: ${this.view_pair.primary_address}`
      );
    const last_subaddress_index = walletSettings.subaddress_index || 0;
    const minor = last_subaddress_index + 1;
    const subaddress = this.view_pair.makeSubaddress(minor);

    await writeWalletToScanSettings({
      primary_address: this.view_pair.primary_address,
      subaddress_index: minor,
      scan_settings_path: this.scan_settings_path,
    });
    const created_at_height = lastRange(this._cache.scanned_ranges)?.end || 0;
    const created_at_timestamp = new Date().getTime();
    if (!this._subaddresses)
      this._subaddresses = structuredClone(this._cache.subaddresses) || [];
    this._subaddresses.push({
      minor,
      address: subaddress,
      created_at_height,
      created_at_timestamp,
    });

    return subaddress;
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
    return await writeWalletToScanSettings({
      primary_address: this.view_pair.primary_address,
      halted: true,
      scan_settings_path: this.scan_settings_path,
    });
  }
  public async unpause() {
    // if worker does not exist yet, start it (if we are not slave / no_worker)

    if (!this.worker && !this.no_worker) {
      this.worker = createWebworker(
        (params) => this.feed(params),
        this.scan_settings_path,
        this.pathPrefix
      );
    }
    return await writeWalletToScanSettings({
      primary_address: this.view_pair.primary_address,
      halted: false,
      scan_settings_path: this.scan_settings_path,
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
   * feed the ScanCacheOpened with new ScanCache as syncing happens
   * if primary_address does not match, do not feed
   * if masterCacheChanged is set, it will be called here
   * for all primary addresses
   */
  public feed(params: CacheChangedCallbackParameters) {
    if (this.masterCacheChanged) this.masterCacheChanged(params);
    if (this.view_pair.primary_address !== params.newCache.primary_address)
      return;
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
    public readonly no_worker: boolean,
    public readonly masterCacheChanged: CacheChangedCallback | null,
    private scan_settings_path?: string,
    private pathPrefix?: string,
    private worker?: Worker
  ) {}
  private _subaddresses: Subaddress[] | undefined;
  private notifyListeners: (CacheChangedCallback | null)[] = [];
}
export type ManyScanCachesOpenedCreateOptions = {
  scan_settings_path?: string;
  pathPrefix?: string;
  no_worker?: boolean;
  notifyMasterChanged?: CacheChangedCallback;
};
export class ManyScanCachesOpened {
  public static async create({
    scan_settings_path,
    pathPrefix,
    no_worker,
    notifyMasterChanged,
  }: ManyScanCachesOpenedCreateOptions) {
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
    const firstNonHaltedWallet = nonHaltedWallets[0];

    if (nonHaltedWallets.length > 1) {
      const slaveWallets: ScanCacheOpened[] = [];
      for (const wallet of nonHaltedWallets.slice(1)) {
        if (!wallet || wallet.halted) continue;
        const slaveWallet = await ScanCacheOpened.create({
          ...wallet,
          no_worker: true, // slaves depend on master worker
          scan_settings_path,
          pathPrefix,
        });
        slaveWallets.push(slaveWallet);
      }
      const masterWallet = await ScanCacheOpened.create({
        ...firstNonHaltedWallet,
        masterCacheChanged: (params) => {
          notifyMasterChanged?.(params);
          for (const slave of slaveWallets) {
            slave.feed(params);
          }
        },
        scan_settings_path,
        pathPrefix,
        no_worker, // pass no_worker, if you want to manually feed()
      });
      openedWallets.push(masterWallet, ...slaveWallets);
    } else {
      const onlyWallet = await ScanCacheOpened.create({
        ...firstNonHaltedWallet,
        scan_settings_path,
        pathPrefix,
      });
      openedWallets.push(onlyWallet);
    }

    return new ManyScanCachesOpened(openedWallets);
  }
  /**
   * feed the master wallet and therefore all wallets
   */
  public feed(params: CacheChangedCallbackParameters) {
    this.wallets[0].feed(params);
  }
  private constructor(public readonly wallets: ScanCacheOpened[]) {}
}
