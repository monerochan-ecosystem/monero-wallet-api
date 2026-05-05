import {
  atomicWrite,
  NodeUrl,
  signTransaction,
  ViewPair,
  type FeeEstimateResponse,
  type Output,
  type SendRawTransactionResult,
} from "../../api";
import {
  prepareInput,
  sumPayments,
  type Payment,
} from "../../send-functionality/inputSelection";
import type {
  Input,
  SendError,
} from "../../send-functionality/transactionBuilding";
import { createWebworker, type WorkerSet } from "../backgroundWorker";
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
  findRange,
  lastRange,
  readCacheFileDefaultLocation,
  writeCacheFileDefaultLocationThrows,
  type CacheChangedCallback,
  type CacheChangedCallbackParameters,
  type ChangedOutput,
  type ScanCache,
  type Subaddress,
  type TxLog,
} from "./scanCache";
import {
  alignScanStatsWithCache,
  isSelfSpent,
  processTxlogInputs,
  processTxlogPayments,
  writeStatsFileDefaultLocation,
  type FoundTransaction,
  type PrePendingTx,
  type ScanStats,
} from "./scanStats";
import {
  updateSyncETA,
  readWriteConnectionStatusFile,
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

export type CreateTransactionParams = {
  payments: Payment[];
  inputs?: Output[];
  no_fee_circuit_breaker?: boolean;
};
export class ScanCacheOpened {
  /** how many decoys to sample per input (default 20, ring size is 11) */
  public decoySampleCount: number = 20;
  /**
   * when true, retry makeInput with higher sample counts on failure.
   *
   * PRIVACY WARNING: retrying contacts the node multiple times for the same
   * input, each time with a different set of candidate indices. this lets the
   * node correlate which output is the real spend across the retries.
   * only ever enable this on your own local trusted node, never on a remote
   * public node.
   *
   * defaults to false, on failure the original error propagates.
   */
  public decoyRetry: boolean = false;
  /** sample sizes to try when decoyRetry is enabled, in order */
  public readonly decoyRetrySizes: number[] = [20, 50, 100, 200, 500];

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
      walletSettings.wallet_name,
      walletSettings.wallet_slot,
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
    scanCacheOpen._stats = await alignScanStatsWithCache(
      scanCacheOpen._cache,
      scanCacheOpen.view_pair,
      params.primary_address,
      params.pathPrefix,
      walletSettings.subaddress_index,
      lastRange(scanCacheOpen._cache.scanned_ranges)?.end,
    );
    return scanCacheOpen;
  }
  get start_height(): number | null {
    return this._start_height;
  }
  get current_height(): number | null {
    let current_range = findRange(
      this._cache.scanned_ranges,
      this._start_height || 0,
    );

    return current_range?.end || null;
  }
  get current_top_range_height(): number | null {
    if (typeof this._stats === "undefined" || this._stats === null) return null;
    return this._stats.height;
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
  get prepending_txs(): PrePendingTx[] {
    const txs = [];
    for (const txlog of this._cache.tx_logs || []) {
      if (
        !txlog ||
        !txlog.sendResult ||
        (txlog.sendResult && txlog.sendResult.status !== "OK")
      )
        continue;
      const { inputSum, alreadyRecognizedAsSpend } = processTxlogInputs(
        txlog,
        this._cache,
      );
      if (alreadyRecognizedAsSpend) continue;

      const outWardPaymentSum = processTxlogPayments(txlog, this._cache);
      const self_spent = isSelfSpent(txlog.payments[0].address, this._cache);
      const destination_address = txlog.payments[0].address;
      const inputs = [];
      for (const inputId of txlog.inputs_index) {
        const input = this._cache.outputs[inputId];
        inputs.push(input);
      }
      const typical_fee = 1000000000n; // 0.001 XMR

      const amount = -outWardPaymentSum - typical_fee;

      const prepending_tx: PrePendingTx = {
        amount,
        txlog,
        inputSum,
        outWardPaymentSum,
        self_spent,
        destination_address,
        inputs,
      };
      txs.push(prepending_tx);
    }
    return txs;
  }
  get transactions(): FoundTransaction[] {
    if (typeof this._stats === "undefined" || this._stats === null) return [];
    const transactions: FoundTransaction[] = [];
    for (const tx of this._stats?.ordered_transactions) {
      transactions.push(this._stats.found_transactions[tx]);
    }
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
      // if there is no scan settings file,
      // the retry loop is stopped.
      // the wallet reset happens through deleting all the scan setting + cache files
      // we want any background retry loops to stop in this case

      //TODO ? write connection status retry
      await this.unpause();
    }
    return scan_settings ? true : false;
  }
  public async sendTransaction(
    signedTx: string,
  ): Promise<SendRawTransactionResult> {
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
  public async calculateFeeAndSelectInputs(
    params: CreateTransactionParams,
  ): Promise<{
    selectedInputs: Output[];
    feeEstimate: {
      status: string;
      fee: number;
      quantization_mask: number;
      fees?: number[] | undefined;
    };
  }> {
    const sum = sumPayments(params.payments);
    const node = await NodeUrl.create(this.node_url);
    // 1. get fee estimate
    const feeEstimate = await node.getFeeEstimate();
    const feePerByte = BigInt(feeEstimate.fees![0]);
    if (!params.no_fee_circuit_breaker) {
      // default is false / undefined -> use fee circuit breaker
      const max_plausible_fee = 20000000000n; // 0.02 XMR
      const feeFor10kb = feePerByte * 10000n;
      //2. check if fee is too high
      if (feeFor10kb > max_plausible_fee) {
        throw new Error(
          `fee too high: 
          ${feeFor10kb} (fee for 10kb tx size) > ${max_plausible_fee} (0.001 XMR)
          most likely your node is faulty. connect to another node.
           preferably run one yourself locally.`,
        );
      }
    }
    // 3. select inputs TODO: log inputs indices
    const selectedInputs = params.inputs || this.selectInputs(sum, feePerByte);
    if (!selectedInputs.length) throw new Error("not enough funds");
    return { selectedInputs, feeEstimate };
  }
  public async makeTransactionFromSelectedInputs(
    payments: Payment[],
    selectedInputs: Output[],
    feeEstimate: FeeEstimateResponse,
  ) {
    // 4. get output distribution
    const node = await NodeUrl.create(this.node_url);

    const distibution = await node.getOutputDistribution();
    const inputs: Input[] = [];

    for (const input of selectedInputs) {
      // 5. sample decoys & get outs from node: here is where a privacy compromising event could happen
      const sizesToTry = this.decoyRetry
        ? this.decoyRetrySizes
        : [this.decoySampleCount];

      let madeInput: Input | undefined;

      for (const size of sizesToTry) {
        if (madeInput) break;
        try {
          const prepared = prepareInput(node, distibution, input, size);
          const wasmInput = node.makeInput(
            prepared.input,
            prepared.sample.candidates,
            await prepared.outsResponse,
          );
          madeInput = wasmInput;
        } catch (e) {
          if (size === sizesToTry[sizesToTry.length - 1]) throw e;
          // fall through to next size
        }
      }

      if (!madeInput) throw new Error("failed to make input");
      inputs.push(madeInput);
    }

    // 7. make transaction: combine inputs, payments + fee info
    const unsignedTx = this.view_pair.makeTransaction({
      inputs,
      payments,
      fee_response: feeEstimate,
      fee_priority: "unimportant",
    });
    return unsignedTx;
  }
  /**
   * this function returns the unsigned transaction, throws {@link SendError}
   */
  public async makeTransaction(params: CreateTransactionParams) {
    const { selectedInputs, feeEstimate } =
      await this.calculateFeeAndSelectInputs(params);
    return await this.makeTransactionFromSelectedInputs(
      params.payments,
      selectedInputs,
      feeEstimate,
    );
  }
  get daemon_height() {
    return this._cache.daemon_height;
  }
  get amount() {
    return this._stats?.total_spendable_amount || 0n;
  }
  get pending_amount() {
    return this._stats?.total_pending_amount || 0n;
  }
  get subaddresses() {
    return Object.values(this._stats?.subaddresses || {});
  }
  get tx_logs() {
    return this._cache.tx_logs || [];
  }
  public async makeSignSendTransaction(params: CreateTransactionParams) {
    let maybeInputs: Output[] = [];
    let maybeFeeEstimate: FeeEstimateResponse;
    let maybeSendResult: SendRawTransactionResult;
    try {
      const { selectedInputs, feeEstimate } =
        await this.calculateFeeAndSelectInputs(params);
      maybeInputs = selectedInputs;
      maybeFeeEstimate = feeEstimate;
      const unsignedTx = await this.makeTransactionFromSelectedInputs(
        params.payments,
        selectedInputs,
        feeEstimate,
      );
      const signedTx = await this.signTransaction(unsignedTx);
      const sendResult = await this.sendTransaction(signedTx);
      maybeSendResult = sendResult;
      if (sendResult.status !== "OK")
        throw new Error("send raw transaction rpc returned error");
      // before writing the scan cache, we stop the worker to avoid a race
      if (this.worker) {
        this.worker.terminate();
        delete this.worker;
      }

      // write txlog to cache + update pending_spent_utxos (affects stats + spendability)
      await writeCacheFileDefaultLocationThrows({
        primary_address: this.primary_address,
        pathPrefix: this.pathPrefix,
        writeCallback: async (cache) => {
          if (!cache.tx_logs) cache.tx_logs = [];
          if (!cache.pending_spent_utxos) cache.pending_spent_utxos = {};
          const inputs_index = selectedInputs.map((input) =>
            String(input.index_on_blockchain),
          );
          const txLog: TxLog = {
            sendResult,
            feeEstimate,
            payments: params.payments,
            node_url: this.node_url,
            inputs_index,
            height: this.current_height!,
            timestamp: Date.now(),
          };
          const newLen = cache.tx_logs.push(txLog);
          const txLogIndex = newLen - 1;
          for (const inputId of inputs_index) {
            cache.pending_spent_utxos[inputId] = txLogIndex;
          }
        },
      });
      const newCache = await readCacheFileDefaultLocation(
        this.primary_address,
        this.pathPrefix,
      );
      if (!newCache)
        throw new Error(
          `cache not found for primary address: ${this.primary_address}, and path prefix: ${this.pathPrefix}`,
        );
      const changed_outputs: ChangedOutput[] = selectedInputs.map((input) => ({
        change_reason: "spent",
        output: input,
      }));
      await this.feed({
        newCache,
        changed_outputs,
      });

      // restart the worker
      await this.unpause();

      return sendResult;
    } catch (e) {
      // before writing the scan cache, we stop the worker to avoid a race
      if (this.worker) {
        this.worker.terminate();
        delete this.worker;
      }
      // write txlog error to cache
      await writeCacheFileDefaultLocationThrows({
        primary_address: this.primary_address,
        pathPrefix: this.pathPrefix,
        writeCallback: async (cache) => {
          if (!cache.tx_logs) cache.tx_logs = [];
          if (!cache.pending_spent_utxos) cache.pending_spent_utxos = {};
          const inputs_index = maybeInputs.map((input) =>
            String(input.index_on_blockchain),
          );
          const txLog: TxLog = {
            sendResult: maybeSendResult,
            error: String(e || "unknown error"),
            feeEstimate: maybeFeeEstimate,
            payments: params.payments,
            node_url: this.node_url,
            inputs_index,
            height: this.current_height!,
            timestamp: Date.now(),
          };
          const newLen = cache.tx_logs.push(txLog);
        },
      });
      const newCache = await readCacheFileDefaultLocation(
        this.primary_address,
        this.pathPrefix,
      );
      if (!newCache)
        throw new Error(
          `cache not found for primary address: ${this.primary_address}, and path prefix: ${this.pathPrefix}`,
        );
      const changed_outputs: ChangedOutput[] = maybeInputs.map((input) => ({
        change_reason: "spent",
        output: input,
      }));
      await this.feed({
        newCache,
        changed_outputs,
      });

      // restart the worker
      await this.unpause();

      throw e;
    }
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
      this.worker = await createWebworker(
        async (params) => await this.feed(params),
        this.scan_settings_path,
        this.pathPrefix,
        (error) => {
          const workerErrCB = this.workerError;
          this.stopWorker();
          readWriteConnectionStatusFile((cs) => {
            if (cs?.last_packet.status === "catastrophic_reorg") return;
            const connectionStatus: ConnectionStatus = {
              ...cs,
              last_packet: {
                status: "connection_failed",
                bytes_read: 0,
                node_url: this.node_url,
                timestamp: new Date().toISOString(),
              },
            };
            return connectionStatus;
          }, this.scan_settings_path).then(() => {
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
      .sort((a, b) => {
        if (b.amount > a.amount) return -1;
        if (b.amount < a.amount) return 1;
        return a.block_height - b.block_height;
      })[0];
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
      .filter((output) =>
        spendable(output, this._cache, this.current_height || 0),
      )
      .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  }
  /**
   * feed the ScanCacheOpened with new ScanCache as syncing happens
   * if primary_address does not match, do not feed
   * if masterCacheChanged is set, it will be called here
   * for all primary addresses
   */
  public async feed(params: CacheChangedCallbackParameters) {
    //TODO update aggregated amount stats + height
    if (this.masterCacheChanged) this.masterCacheChanged(params);
    if (this.view_pair.primary_address !== params.newCache.primary_address)
      return;
    this._cache = params.newCache;
    this._stats = await alignScanStatsWithCache(
      this._cache,
      this.view_pair,
      this.primary_address,
      this.pathPrefix,
      undefined,
      lastRange(this._cache.scanned_ranges)?.end,
    );

    if (!this.no_worker) {
      const etaResult = await updateSyncETA(
        this._cache.daemon_height,
        this.current_height || 0,
        this.last_eta_height,
        this.last_eta_timestamp,
        this.scan_settings_path,
      );
      this.last_eta_height = etaResult.last_height;
      this.last_eta_timestamp = etaResult.last_timestamp;
    }

    for (const listener of this.notifyListeners) {
      if (listener) listener(params);
    }
  }

  private _cache: ScanCache = {
    daemon_height: 0,
    outputs: {},
    own_key_images: {},
    scanned_ranges: [],
    primary_address: "",
  };
  private worker?: WorkerSet = undefined;
  private last_eta_height: number | null = null;
  private last_eta_timestamp: number | null = null;

  private constructor(
    public readonly view_pair: ViewPair,
    public readonly wallet_route: string | undefined,
    public readonly wallet_name: string | undefined,
    public readonly wallet_slot: number | undefined,
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
  get current_height(): number | null {
    if (this.wallets.length === 0) return null;
    return this.wallets[0]?.current_height;
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
        masterCacheChanged: async (params) => {
          notifyMasterChanged?.(params);
          for (const slave of slaveWallets) {
            await slave.feed(params);
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
        masterCacheChanged: async (params) => {
          notifyMasterChanged?.(params);
        },
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
  public async feed(params: CacheChangedCallbackParameters) {
    await this.wallets[0].feed(params);
  }
  private constructor(public readonly wallets: ScanCacheOpened[]) {}
}
