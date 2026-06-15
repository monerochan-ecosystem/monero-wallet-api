import {
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
  getPathPrefix,
  readPrivateSpendKeyFromEnv,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  SUB_ADDRESS_INDEX_DEFAULT_VALUE,
  walletSettingsPlusKeys,
} from "../../api";
import { ScanSettingsOpened } from "../../scansettings/scanSettingsOpened";
import { ConnectionStatusOpened } from "../connectionStatusOpened";
import type { LogSetting, PossibleLogs } from "../../io/logging";
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

    if (!params.primary_address)
      throw new Error(
        `primary_address is required, potentially half filled out wallet setting in: ${
          params.scan_settings_path || SCAN_SETTINGS_STORE_NAME_DEFAULT
        }`,
      );

    // use ScanSettingsOpened instead of direct scanSettings calls
    const scanSettings = await ScanSettingsOpened.create(
      params.scan_settings_path,
      params.pathPrefix,
    );
    const walletSettings = scanSettings.getWallet(params.primary_address);
    if (!walletSettings)
      throw new Error(
        `wallet not found in settings. did you call openwallet with the right params?
      Either wrong file name supplied to params.scan_settings_path: ${params.scan_settings_path}
      Or wrong primary_address supplied params.primary_address: ${params.primary_address}`,
      );

    const walletWithSettings = {
      ...walletSettings,
      node_url: scanSettings.node_url,
      start_height: scanSettings.start_height,
    };
    // read secret_view_key and secret_spend_key from env
    const walletSettingsWithKeys =
      await walletSettingsPlusKeys(walletWithSettings);

    // create viewpair + ScanCacheOpened instance
    const scanCacheOpen = new ScanCacheOpened(
      scanSettings,
      await ViewPair.create(
        params.primary_address,
        walletSettingsWithKeys.secret_view_key,
        walletSettings.subaddress_index,
        scanSettings.node_url,
      ),
      walletSettings.wallet_route,
      walletSettings.wallet_name,
      walletSettings.wallet_slot,
      params.no_worker || false,
      params.masterCacheChanged || null,
      scanSettings.start_height,
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
    scanCacheOpen._highest_subaddress_index =
      walletSettings.subaddress_index || SUB_ADDRESS_INDEX_DEFAULT_VALUE;
    if (!params.no_stats) {
      scanCacheOpen._stats = await alignScanStatsWithCache(
        scanCacheOpen._cache,
        scanCacheOpen.view_pair,
        params.primary_address,
        getPathPrefix(params.scan_settings_path, params.pathPrefix),
        walletSettings.subaddress_index,
        lastRange(scanCacheOpen._cache.scanned_ranges)?.end,
      );
    } else {
      scanCacheOpen._no_stats = params.no_stats; // true
    }
    return scanCacheOpen;
  }
  get start_height(): number | null {
    return this._start_height;
  }

  get subaddress_index(): number {
    if (
      typeof this._highest_subaddress_index === "undefined" ||
      this._highest_subaddress_index === null
    )
      return SUB_ADDRESS_INDEX_DEFAULT_VALUE;
    return this._highest_subaddress_index;
  }
  get current_height(): number | null {
    let current_range = findRange(
      this._cache.scanned_ranges,
      this._start_height || 0,
    );

    return current_range?.end || null;
  }
  get current_top_range_height(): number | null {
    if (typeof this._stats === "undefined" || this._stats === null)
      return this.current_height;
    return this._stats.height;
  }

  public async changeStartHeight(start_height: number | null) {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }

    await this._scanSettings.setStartHeight(start_height);
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
  get merchant_confirmations(): number | null | undefined {
    return this._scanSettings.merchant_confirmations;
  }
  get cpu_worker_count(): number | undefined {
    return this._scanSettings.cpu_worker_count;
  }
  get logs(): LogSetting | undefined {
    return this._scanSettings.logs;
  }
  get logs_include(): PossibleLogs[] | undefined {
    return this._scanSettings.logs_include;
  }
  get logs_exclude(): PossibleLogs[] | undefined {
    return this._scanSettings.logs_exclude;
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
      await this._scanSettings.setNodeUrl(node_url);
      this.node_url = node_url;
    }

    if (start_height !== undefined) {
      await this._scanSettings.setStartHeight(start_height);
      this._start_height = start_height;
    }

    await this.unpause();
  }
  public async changeNodeUrl(node_url: string) {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }

    await this._scanSettings.setNodeUrl(node_url);
    this.node_url = node_url;
    await this.unpause();
  }
  public async setMerchantConfirmations(merchant_confirmations: number | null) {
    this.stopWorker();
    await this._scanSettings.setMerchantConfirmations(merchant_confirmations);
    await this.unpause();
  }
  public async setCpuWorkerCount(cpu_worker_count: number | undefined) {
    this.stopWorker();
    await this._scanSettings.setCpuWorkerCount(cpu_worker_count);
    await this.unpause();
  }
  public async setLogSettings(
    logs?: LogSetting | null,
    logs_include?: PossibleLogs[] | null,
    logs_exclude?: PossibleLogs[] | null,
  ) {
    this.stopWorker();
    await this._scanSettings.setLogSettings(logs, logs_include, logs_exclude);
    await this.unpause();
  }
  public async setWalletName(name?: string) {
    await this._scanSettings.setWalletName(
      this.view_pair.primary_address,
      name,
    );
  }
  public async retry() {
    if (this.worker) {
      this.worker.terminate();
      delete this.worker;
    }
    //  scansettings  so external changes (e.g. from a sidebar frontend instance) are picked up
    await this._scanSettings.reload();
    const walletStillExists = this._scanSettings.walletExists(
      this.primary_address,
    );

    if (walletStillExists) {
      // if there is no scan settings file,
      // the retry loop is stopped.
      // the wallet reset happens through deleting all the scan setting + cache files
      // we want any background retry loops to stop in this case

      //TODO ? write connection status retry
      await this.unpause();
    }
    return walletStillExists;
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
  public async getFeeEstimate() {
    const node = await NodeUrl.create(this.node_url);
    const feeEstimate = await node.getFeeEstimate();
    const feePerByte = BigInt(feeEstimate.fees![0]);

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

    return feeEstimate;
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
  public async makeSweepTransactionFromSelectedInputs(
    destination_address: string,
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
    const unsignedTx = this.view_pair.makeSweepTransaction({
      inputs,
      payments: [
        {
          address: destination_address,
          amount: "0",
        },
      ],
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
  /**
   * sweep inputs to external wallet address (the wallet will receive input amount - fee)
   * @param inputs     use spendableInputs() to find inputs to put in
   */
  public async sweepToExternalWallet(
    destination_address: string,
    inputs: Output[],
  ) {
    const feeEstimate = await this.getFeeEstimate();
    return await this.makeSweepTransactionFromSelectedInputs(
      destination_address,
      inputs,
      feeEstimate,
    );
  }
  get daemon_height() {
    return this._cache.daemon_height;
  }
  get amount() {
    if (this.no_stats) throw new Error("instance has no_stats option active");
    return this._stats?.total_spendable_amount || 0n;
  }
  get pending_amount() {
    if (this.no_stats) throw new Error("instance has no_stats option active");
    return this._stats?.total_pending_amount || 0n;
  }
  get subaddresses() {
    if (this.no_stats) throw new Error("instance has no_stats option active");

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
    // reload scansettings so external changes (e.g. from a sidebar frontend instance) are picked up
    await this._scanSettings.reload();
    const walletSettings = this._scanSettings.getWallet(
      this.view_pair.primary_address,
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
    this._highest_subaddress_index = minor;

    await this._scanSettings.setSubaddressIndex(
      this.view_pair.primary_address,
      minor,
    );
    const created_at_height = lastRange(this._cache.scanned_ranges)?.end || 0;
    const created_at_timestamp = new Date().getTime();

    const new_subaddress: Subaddress = {
      minor,
      address: subaddress,
      created_at_height,
      created_at_timestamp,
      not_yet_included: true,
    };
    if (!this._no_stats)
      this._stats = await writeStatsFileDefaultLocation({
        primary_address: this.primary_address,
        pathPrefix: getPathPrefix(this.scan_settings_path, this.pathPrefix),
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
    return await this._scanSettings.haltWallet(this.view_pair.primary_address);
  }
  public stopWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker.cpuWorkers = [];
      this.worker.fetchWorker = undefined!;
      delete this.worker;
    }
  }
  public async unpause() {
    // if worker does not exist yet, start it (if we are not slave / no_worker)

    if (!this.worker && !this.no_worker) {
      this.worker = await createWebworker(
        this.feed,
        this.scan_settings_path,
        this.pathPrefix,
        this._onWorkerError,
      );
    }
    return await this._scanSettings.unhaltWallet(
      this.view_pair.primary_address,
    );
  }
  private _onWorkerError = (error: unknown) => {
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
  };
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
    if (!this._no_stats)
      this._stats = await alignScanStatsWithCache(
        this._cache,
        this.view_pair,
        this.primary_address,
        getPathPrefix(this.scan_settings_path, this.pathPrefix),
        this.subaddress_index,
        lastRange(this._cache.scanned_ranges)?.end,
      );

    for (const listener of this.notifyListeners) {
      if (listener) listener(params);
    }
  }
  private _highest_subaddress_index: number | null = null;
  private _no_stats: boolean = false;
  public get no_stats(): boolean {
    return this._no_stats;
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
    private _scanSettings: ScanSettingsOpened,
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
  autoRetry?: boolean;
  retryDelayMs?: number;
  connectionStatusIntervalMs?: number;
  onConnectionStatusChange?: ((status: ConnectionStatus | null) => void) | null;
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
  get merchant_confirmations(): number | null | undefined {
    if (this.wallets.length === 0) return undefined;
    return this.wallets[0]?.merchant_confirmations;
  }
  get cpu_worker_count(): number | undefined {
    if (this.wallets.length === 0) return undefined;
    return this.wallets[0]?.cpu_worker_count;
  }
  get logs(): LogSetting | undefined {
    if (this.wallets.length === 0) return undefined;
    return this.wallets[0]?.logs;
  }
  get logs_include(): PossibleLogs[] | undefined {
    if (this.wallets.length === 0) return undefined;
    return this.wallets[0]?.logs_include;
  }
  get logs_exclude(): PossibleLogs[] | undefined {
    if (this.wallets.length === 0) return undefined;
    return this.wallets[0]?.logs_exclude;
  }
  get connectionStatus(): ConnectionStatus | null {
    return this.connectionStatusOpened.connectionStatus;
  }
  get daemonHeight(): number | undefined {
    return this.connectionStatusOpened.daemonHeight;
  }
  watchConnectionStatus(intervalMs?: number) {
    this.connectionStatusOpened.watch(intervalMs);
  }
  unwatchConnectionStatus() {
    this.connectionStatusOpened.unwatch();
  }
  public async setMerchantConfirmations(merchant_confirmations: number | null) {
    if (this.wallets.length === 0) throw new Error("no wallets");
    return await this.wallets[0].setMerchantConfirmations(
      merchant_confirmations,
    );
  }
  public async setCpuWorkerCount(cpu_worker_count: number | undefined) {
    if (this.wallets.length === 0) throw new Error("no wallets");
    return await this.wallets[0].setCpuWorkerCount(cpu_worker_count);
  }
  public async setLogSettings(
    logs?: LogSetting | null,
    logs_include?: PossibleLogs[] | null,
    logs_exclude?: PossibleLogs[] | null,
  ) {
    if (this.wallets.length === 0) throw new Error("no wallets");
    return await this.wallets[0].setLogSettings(
      logs,
      logs_include,
      logs_exclude,
    );
  }
  public async setWalletName(primary_address: string, name?: string) {
    await this._scanSettings.setWalletName(primary_address, name);
  }
  public async setWalletSlot(primary_address: string, slot?: number) {
    await this._scanSettings.setWalletSlot(primary_address, slot);
  }
  public async changeStartHeight(start_height: number | null) {
    if (this.wallets.length === 0) throw new Error("no wallets");
    const masterWallet = this.wallets[0];
    return await masterWallet.changeStartHeight(start_height);
  }
  private static async _buildWallets(
    scanSettingsOpened: ScanSettingsOpened,
    options: ManyScanCachesOpenedCreateOptions,
  ): Promise<ScanCacheOpened[] | undefined> {
    const {
      scan_settings_path,
      pathPrefix,
      no_worker,
      no_stats,
      workerError,
      notifyMasterChanged,
    } = options;
    const nonHaltedWallets = scanSettingsOpened.wallets.filter(
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

    return openedWallets;
  }

  public static async create(options: ManyScanCachesOpenedCreateOptions) {
    const {
      scan_settings_path,
      pathPrefix,
      onConnectionStatusChange,
      connectionStatusIntervalMs,
      autoRetry,
      retryDelayMs,
    } = options;
    const scanSettingsOpened = await ScanSettingsOpened.create(
      scan_settings_path,
      pathPrefix,
    );
    if (!scanSettingsOpened.wallets || scanSettingsOpened.wallets.length === 0)
      throw new Error(
        `no wallets in settings file. Did you supply the right path?
     are there wallets in the default '${SCAN_SETTINGS_STORE_NAME_DEFAULT}' file?`,
      );

    // wrap workerError with auto-retry
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let instance: ManyScanCachesOpened | null = null;
    const retryFn = async () => {
      await instance?.buildWallets();
      await instance?.retry();
      clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const newOptions = { ...options };
    let connectionFailedShown = false;
    if (autoRetry) {
      const originalError = options.workerError;
      newOptions.workerError = (err: unknown) => {
        originalError?.(err);
        const msg = err instanceof Error ? err.message : String(err);
        if (
          csOpened.connectionStatus?.last_packet?.status ===
          "catastrophic_reorg"
        ) {
          clearTimeout(retryTimer);
          instance?.stopWorker();
          throw new Error("catastrophic reorg, aborting ...");
        }
        if (
          msg.includes("connect") ||
          msg.includes("fetch") ||
          msg.includes("NetworkError")
        ) {
          if (!connectionFailedShown) {
            connectionFailedShown = true;
            console.error("unable to connect to node ... retrying ...");
          }
        }
        if (!retryTimer) {
          retryTimer = setTimeout(retryFn, retryDelayMs ?? 1000);
        }
      };
    }

    const wallets = await this._buildWallets(scanSettingsOpened, newOptions);
    if (!wallets) return undefined;

    const csOpened = new ConnectionStatusOpened(
      scan_settings_path || SCAN_SETTINGS_STORE_NAME_DEFAULT,
      autoRetry
        ? (status) => {
            if (status?.last_packet?.status === "OK" && connectionFailedShown) {
              connectionFailedShown = false;
              console.log("connection to node established");
            }
            if (onConnectionStatusChange) onConnectionStatusChange(status);
          }
        : (onConnectionStatusChange ?? null),
    );
    csOpened.watch(connectionStatusIntervalMs);

    instance = new ManyScanCachesOpened(
      wallets,
      csOpened,
      scanSettingsOpened,
      newOptions,
    );

    return instance;
  }

  public async buildWallets() {
    this.stopWorker();
    await this._scanSettings.reload();
    const newWallets = await ManyScanCachesOpened._buildWallets(
      this._scanSettings,
      this._options,
    );
    if (!newWallets)
      throw new Error(
        "no non-halted wallets left after rebuild, use addViewWallet or addSpendWallet first",
      );
    this._wallets = newWallets;
  }

  public async addViewWallet(
    primary_address: string,
    view_key: string,
    fields?: {
      wallet_name?: string;
      wallet_slot?: number;
      wallet_route?: string;
      subaddress_index?: number;
      halted?: boolean;
    },
  ) {
    await this._scanSettings.addViewWallet(primary_address, view_key, fields);
    await this.buildWallets();
  }

  public async addSpendWallet(
    wallet_secret: Uint8Array,
    fields?: {
      wallet_name?: string;
      wallet_slot?: number;
      wallet_route?: string;
      subaddress_index?: number;
      halted?: boolean;
    },
  ) {
    await this._scanSettings.addSpendWallet(wallet_secret, fields);
    await this.buildWallets();
  }

  public async removeWallet(primary_address: string) {
    await this._scanSettings.removeWallet(primary_address);
    await this.buildWallets();
  }

  public async feed(params: CacheChangedCallbackParameters) {
    await this.wallets[0].feed(params);
  }

  private _wallets: ScanCacheOpened[] = [];

  get wallets(): ScanCacheOpened[] {
    return this._wallets;
  }

  private constructor(
    wallets: ScanCacheOpened[],
    public readonly connectionStatusOpened: ConnectionStatusOpened,
    private _scanSettings: ScanSettingsOpened,
    private _options: ManyScanCachesOpenedCreateOptions,
  ) {
    this._wallets = wallets;
  }
}
