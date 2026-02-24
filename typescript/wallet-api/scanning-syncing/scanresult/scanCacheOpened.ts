import {
  atomicWrite,
  NodeUrl,
  signTransaction,
  ViewPair,
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
import { createWebworker } from "../backgroundWorker";
import { spendable } from "./scanResult";
import {
  openScanSettingsFile,
  readPrivateSpendKeyFromEnv,
  readWalletFromScanSettings,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  walletSettingsPlusKeys,
  writeNodeUrlToScanSettings,
  writeStartHeightToScanSettings,
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
import {
  addMissingSubAddressesToScanStats,
  sumOutputs,
  writeStatsFileDefaultLocation,
  type ScanStats,
} from "./scanStats";
import {
  connectionStatusFilePath,
  type ConnectionStatus,
} from "../connectionStatus";

export type SlaveScanCache = boolean;
export type ScanCacheOpenedCreateParams = {
  primary_address: string;
  scan_settings_path?: string; // Default: SCAN_SETTINGS_STORE_NAME_DEFAULT = "ScanSettings.json"
  pathPrefix?: string;
  no_worker?: boolean;
  no_stats?: boolean;
  masterCacheChanged?: CacheChangedCallback;
  workerError?: (error: unknown) => void;
};
// every tx has an output, get more info from outputs[0]
export type FoundTransaction = {
  amount: bigint;
  outputs: Output[];
  tx_hash: string;
};
export type CreateTransactionParams = {
  payments: Payment[];
  inputs?: Output[];
};
export class ScanCacheOpened {
  public static async create(params: ScanCacheOpenedCreateParams) {
    const theCatchToBeOpened = await readCacheFileDefaultLocation(
      params.primary_address,
      params.pathPrefix,
    );

    const walletSettings = await readWalletFromScanSettings(
      params.primary_address,
      params.scan_settings_path,
    );
    if (!walletSettings)
      throw new Error(
        `wallet not found in settings. did you call openwallet with the right params?
      Either wrong file name supplied to params.scan_settings_path: ${params.scan_settings_path}
      Or wrong primary_address supplied params.primary_address: ${params.primary_address}`,
      );
    if (!params.primary_address)
      throw new Error(
        `primary_address is required, potentially half filled out wallet setting in: ${
          params.scan_settings_path || SCAN_SETTINGS_STORE_NAME_DEFAULT
        }`,
      );
    // read secret_view_key and secret_spend_key from env
    const walletSettingsWithKeys = await walletSettingsPlusKeys(walletSettings);

    // create viewpair + ScanCacheOpened instance
    const scanCacheOpen = new ScanCacheOpened(
      await ViewPair.create(
        params.primary_address,
        walletSettingsWithKeys.secret_view_key,
        walletSettings.subaddress_index,
        walletSettings.node_url,
      ),
      walletSettings.wallet_route,
      params.no_worker || false,
      params.masterCacheChanged || null,
      walletSettings.start_height,
      params.scan_settings_path,
      params.pathPrefix,
      params.workerError,
    );
    if (theCatchToBeOpened) scanCacheOpen._cache = theCatchToBeOpened;

    if (!walletSettings.halted) {
      // run webworker (respecting halted param + setting)
      // unpause will start scanning from this.wallet_scan_settings.start_height
      await scanCacheOpen.unpause();
    }
    scanCacheOpen._stats = await writeStatsFileDefaultLocation({
      primary_address: params.primary_address,
      pathPrefix: params.pathPrefix,
      writeCallback: async (stats) => {
        const end = lastRange(scanCacheOpen._cache.scanned_ranges)?.end || 0;
        if (!end || end > stats.height) {
          // add cache subaddresses to statsfile
          for (const cacheSub of scanCacheOpen._cache.subaddresses || []) {
            if (!stats.subaddresses[cacheSub.minor.toString()])
              stats.subaddresses[cacheSub.minor.toString()] = {
                minor: cacheSub.minor,
                address: cacheSub.address,
                created_at_height: cacheSub.created_at_height,
                created_at_timestamp: cacheSub.created_at_timestamp,
                amount: 0n,
              };
          }
          addMissingSubAddressesToScanStats(
            stats,
            scanCacheOpen.view_pair,
            walletSettings.subaddress_index,
            lastRange(scanCacheOpen._cache.scanned_ranges)?.end,
          );

          stats.total_amount = sumOutputs(scanCacheOpen._cache.outputs, stats);
          stats.height = end;
        }
      },
    });
    return scanCacheOpen;
  }
  get start_height(): number | null {
    return this._start_height;
  }

  public async changeStartHeight(start_height: number | null) {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }

    await writeStartHeightToScanSettings(start_height, this.scan_settings_path);
    this._start_height = start_height;
    await this.unpause();
  }

  get cache(): ScanCache {
    return this._cache;
  }
  get transactions(): FoundTransaction[] {
    const transactions: FoundTransaction[] = [];
    let last_tx: FoundTransaction | null = null;
    Object.entries(this._cache.outputs).forEach(([_, output]) => {
      if (last_tx && last_tx?.tx_hash === output.tx_hash) {
        last_tx.outputs.push(output);
        last_tx.amount += output.amount;
      } else {
        last_tx = {
          amount: output.amount,
          outputs: [output],
          tx_hash: output.tx_hash,
        };
        transactions.push(last_tx);
      }
    });
    return transactions;
  }
  get primary_address(): string {
    return this.view_pair.primary_address;
  }
  get node_url(): string {
    return this.view_pair.node_url;
  }
  private set node_url(nu: string) {
    this.view_pair.node_url = nu;
  }
  public async changeNodeUrlAndStartHeight(
    node_url?: string,
    start_height?: number | null,
  ) {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }
    if (node_url !== undefined) {
      await writeNodeUrlToScanSettings(node_url, this.scan_settings_path);
      this.node_url = node_url;
    }

    if (start_height !== undefined) {
      await writeStartHeightToScanSettings(
        start_height,
        this.scan_settings_path,
      );
      this._start_height = start_height;
    }

    await this.unpause();
  }
  public async changeNodeUrl(node_url: string) {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }

    await writeNodeUrlToScanSettings(node_url, this.scan_settings_path);
    this.node_url = node_url;
    await this.unpause();
  }
  public async retry() {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }
    const scan_settings = await readWalletFromScanSettings(
      this.primary_address,
      this.scan_settings_path,
    ).catch(() => false);

    if (scan_settings) {
      //TODO ? write connection status retry
      await this.unpause();
    }
    return scan_settings ? true : false;
  }
  public async sendTransaction(signedTx: string) {
    const node = await NodeUrl.create(this.node_url);
    return await node.sendRawTransaction(signedTx);
  }
  public async signTransaction(unsignedTx: string) {
    const privateSpendKey = readPrivateSpendKeyFromEnv(
      this._cache.primary_address,
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
      params.inputs || this.selectInputs(sum, BigInt(feeEstimate.fees![0]));
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
        await preparedInput.outsResponse,
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
  get amount() {
    return this._stats?.total_amount || 0n;
  }
  get subaddresses() {
    return Object.values(this._stats?.subaddresses || {});
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
  public async makeSubaddress(): Promise<Subaddress> {
    const walletSettings = await readWalletFromScanSettings(
      this.view_pair.primary_address,
      this.scan_settings_path,
    );
    if (!walletSettings)
      throw new Error(
        `wallet not found in settings. did you call openwallet with the right params?
      Either wrong file name supplied to params.scan_settings_path: ${this.scan_settings_path}
      Or wrong primary_address supplied params.primary_address: ${this.view_pair.primary_address}`,
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

    const new_subaddress: Subaddress = {
      minor,
      address: subaddress,
      created_at_height,
      created_at_timestamp,
      not_yet_included: true,
    };
    this._stats = await writeStatsFileDefaultLocation({
      primary_address: this.primary_address,
      pathPrefix: this.pathPrefix,
      writeCallback: async (stats) => {
        stats.subaddresses[minor.toString()] = new_subaddress;
      },
    });
    return new_subaddress;
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
  public stopWorker() {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }
  }
  public async unpause() {
    // if worker does not exist yet, start it (if we are not slave / no_worker)

    if (!this.worker && !this.no_worker) {
      this.worker = createWebworker(
        (params) => this.feed(params),
        this.scan_settings_path,
        this.pathPrefix,
        (error) => {
          const workerErrCB = this.workerError;
          const connectionStatus: ConnectionStatus = {
            last_packet: {
              status: "connection_failed",
              bytes_read: 0,
              node_url: this.node_url,
              timestamp: new Date().toISOString(),
            },
          };
          atomicWrite(
            connectionStatusFilePath(this.scan_settings_path),
            JSON.stringify(connectionStatus, null, 2),
          ).then(() => {
            if (workerErrCB) workerErrCB(error);
          });
        },
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
  public selectInputs(amount: bigint, feePerByte?: bigint) {
    if (feePerByte) amount += feePerByte * 10000n; // 10kb * feePerByte; for sweeping low amounts inputs[] supplied directly
    const oneInputIsEnough = this.selectOneInput(amount);
    if (oneInputIsEnough) return [oneInputIsEnough];
    return this.selectMultipleInputs(amount);
  }
  /**
   * selectOneInput larger than amount, (smallest one matching this amount)
   */
  public selectOneInput(amount: bigint): Output | undefined {
    return this.spendableInputs()
      .filter((output) => output.amount >= amount)
      .sort((a, b) =>
        b.amount > a.amount ? -1 : b.amount < a.amount ? 1 : 0,
      )[0];
  }
  /**
   * selectMultipleInputs larger than amount, sorted from largest to smallest until total reaches amount
   */
  public selectMultipleInputs(amount: bigint) {
    const selected = [];
    let total = 0n;

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
      .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  }
  /**
   * feed the ScanCacheOpened with new ScanCache as syncing happens
   * if primary_address does not match, do not feed
   * if masterCacheChanged is set, it will be called here
   * for all primary addresses
   */
  public feed(params: CacheChangedCallbackParameters) {
    //TODO update aggregated amount stats + height
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
  private worker?: Worker = undefined;

  private constructor(
    public readonly view_pair: ViewPair,
    public readonly wallet_route: string | undefined,
    public readonly no_worker: boolean,
    public readonly masterCacheChanged: CacheChangedCallback | null,
    private _start_height: number | null,
    private scan_settings_path?: string,
    private pathPrefix?: string,
    private workerError?: (error: unknown) => void,
  ) {}
  private _stats: ScanStats | null = null;
  private notifyListeners: (CacheChangedCallback | null)[] = [];
}
export type ManyScanCachesOpenedCreateOptions = {
  scan_settings_path?: string;
  pathPrefix?: string;
  no_worker?: boolean;
  notifyMasterChanged?: CacheChangedCallback;
  no_stats?: boolean;
  workerError?: (error: unknown) => void;
};
export class ManyScanCachesOpened {
  get start_height(): number | null {
    if (this.wallets.length === 0) return null;
    return this.wallets[0]?.start_height;
  }
  get node_url(): string {
    if (this.wallets.length === 0) return "";
    return this.wallets[0]?.node_url;
  }
  public async changeNodeUrlAndStartHeight(
    node_url?: string,
    start_height?: number | null,
  ) {
    if (this.wallets.length === 0) throw new Error("no wallets");
    const masterWallet = this.wallets[0];
    return await masterWallet.changeNodeUrlAndStartHeight(
      node_url,
      start_height,
    );
  }
  public async retry() {
    if (this.wallets.length === 0) throw new Error("no wallets");
    const masterWallet = this.wallets[0];
    return await masterWallet.retry();
  }
  public stopWorker() {
    if (this.wallets.length === 0) throw new Error("no wallets");
    const masterWallet = this.wallets[0];
    return masterWallet.stopWorker();
  }

  public async changeNodeUrl(node_url: string) {
    if (this.wallets.length === 0) throw new Error("no wallets");
    const masterWallet = this.wallets[0];
    return await masterWallet.changeNodeUrl(node_url);
  }
  public async changeStartHeight(start_height: number | null) {
    if (this.wallets.length === 0) throw new Error("no wallets");
    const masterWallet = this.wallets[0];
    return await masterWallet.changeStartHeight(start_height);
  }
  public static async create({
    scan_settings_path,
    pathPrefix,
    no_worker,
    notifyMasterChanged,
    no_stats,
    workerError,
  }: ManyScanCachesOpenedCreateOptions) {
    const scan_settings = await openScanSettingsFile(scan_settings_path);
    if (!scan_settings?.wallets)
      throw new Error(
        `no wallets in settings file. Did you supply the right path?
     are there wallets in the default '${SCAN_SETTINGS_STORE_NAME_DEFAULT}' file?`,
      );
    const nonHaltedWallets = scan_settings.wallets.filter(
      (wallet) => !wallet?.halted,
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
          no_stats,
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
        no_stats,
        no_worker, // pass no_worker, if you want to manually feed()
        workerError,
      });
      openedWallets.push(masterWallet, ...slaveWallets);
    } else {
      const onlyWallet = await ScanCacheOpened.create({
        ...firstNonHaltedWallet,
        scan_settings_path,
        pathPrefix,
        no_stats,
        no_worker, // pass no_worker, if you want to manually feed()
        workerError,
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
