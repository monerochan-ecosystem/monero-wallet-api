import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";
import {
  LOGGING_FUNCTIONS,
  type LogSetting,
  type PossibleLogs,
} from "../io/logging";
import {
  getPathPrefix,
  makeSpendKeyFromSeed,
  makeViewKey,
  openScanSettingsFile,
  SCAN_SETTINGS_STORE_NAME_DEFAULT,
  SUB_ADDRESS_INDEX_DEFAULT_VALUE,
  walletSettingsPlusKeys,
  writeEnvLineToDotEnvRefresh,
  writeScanSettings,
  writeViewKeyToDotEnv,
  type ScanSetting,
  type ScanSettingOpened,
  type ScanSettings,
} from "../api";

export class ScanSettingsOpened {
  /**
   * open the settings file and return a new ScanSettingsOpened instance.
   * if the file does not exist, creates one with defaults.
   */
  public static async create(
    scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT,
    pathPrefix?: string,
  ) {
    pathPrefix = getPathPrefix(scan_settings_path, pathPrefix);

    let settings = await openScanSettingsFile(scan_settings_path);
    if (!settings) {
      settings = {
        wallets: [],
        node_url: LOCAL_NODE_DEFAULT_URL,
        start_height: null,
      };
      // persist the defaults so the file exists on disk
      await writeScanSettings(settings, scan_settings_path);
    }

    ScanSettingsOpened._validateLogOptions(
      settings.logs_include,
      settings.logs_exclude,
    );

    return new ScanSettingsOpened(settings, scan_settings_path, pathPrefix);
  }

  public get node_url(): string {
    return this._settings.node_url;
  }

  public get start_height(): number | null {
    return this._settings.start_height;
  }

  public get merchant_confirmations(): number | null | undefined {
    return this._settings.merchant_confirmations;
  }

  public get cpu_worker_count(): number | undefined {
    return this._settings.cpu_worker_count;
  }

  public get logs(): LogSetting | undefined {
    return this._settings.logs;
  }

  public get logs_include(): PossibleLogs[] | undefined {
    return this._settings.logs_include;
  }

  public get logs_exclude(): PossibleLogs[] | undefined {
    return this._settings.logs_exclude;
  }

  public get wallets(): ScanSetting[] {
    return this._settings.wallets;
  }

  public get scan_settings_path(): string {
    return this._scan_settings_path;
  }

  public get pathPrefix(): string {
    return this._pathPrefix;
  }

  public async setNodeUrl(node_url: string) {
    await this.reload();
    this._settings.node_url = ScanSettingsOpened._validateNodeUrl(node_url);
    await this._persist();
  }

  public async setStartHeight(start_height: number | null) {
    await this.reload();
    ScanSettingsOpened._validateStartHeight(start_height);
    this._settings.start_height = start_height;
    await this._persist();
  }

  public async setMerchantConfirmations(
    merchant_confirmations: number | undefined | null,
  ) {
    await this.reload();
    if (
      merchant_confirmations === undefined ||
      merchant_confirmations === null
    ) {
      delete this._settings.merchant_confirmations;
    } else {
      ScanSettingsOpened._validateMerchantConfirmations(merchant_confirmations);
      this._settings.merchant_confirmations = merchant_confirmations;
    }
    await this._persist();
  }

  public async setCpuWorkerCount(cpu_worker_count: number | undefined | null) {
    await this.reload();
    if (cpu_worker_count === null || cpu_worker_count === undefined) {
      delete this._settings.cpu_worker_count;
    } else {
      ScanSettingsOpened._validateCpuWorkerCount(cpu_worker_count);
      this._settings.cpu_worker_count = cpu_worker_count;
    }
    await this._persist();
  }

  public async setLogSettings(
    logs?: LogSetting | null,
    logs_include?: PossibleLogs[] | null,
    logs_exclude?: PossibleLogs[] | null,
  ) {
    await this.reload();
    if (logs === null) {
      delete this._settings.logs;
    } else {
      this._settings.logs = logs;
    }
    if (logs_include === null) {
      delete this._settings.logs_include;
    } else {
      this._settings.logs_include = logs_include;
    }
    if (logs_exclude === null) {
      delete this._settings.logs_exclude;
    } else {
      this._settings.logs_exclude = logs_exclude;
    }

    // validate before persisting
    ScanSettingsOpened._validateLogOptions(
      this._settings.logs_include,
      this._settings.logs_exclude,
    );

    await this._persist();
  }

  /**
   * get a wallet's settings (without env keys).
   * returns undefined if not found.
   */
  public getWallet(primary_address: string): ScanSetting | undefined {
    return this._settings.wallets.find(
      (w) => w.primary_address === primary_address,
    );
  }

  /**
   * get a wallet's settings merged with env keys.
   * throws if not found or view key missing.
   */
  public async getWalletOpened(
    primary_address: string,
  ): Promise<ScanSettingOpened> {
    const wallet = this.getWallet(primary_address);
    if (!wallet)
      throw new Error(
        `wallet not found: ${primary_address} in ${this._scan_settings_path}`,
      );
    return await walletSettingsPlusKeys({
      ...wallet,
      node_url: this._settings.node_url,
      start_height: this._settings.start_height,
    });
  }

  /**
   * get all wallets merged with env keys.
   * wallets missing env keys are skipped.
   */
  public async getWalletsOpened(): Promise<ScanSettingOpened[]> {
    const opened: ScanSettingOpened[] = [];
    for (const wallet of this._settings.wallets) {
      try {
        const withKeys = await walletSettingsPlusKeys({
          ...wallet,
          node_url: this._settings.node_url,
          start_height: this._settings.start_height,
        });
        opened.push(withKeys);
      } catch {
        // wallet has no view key in env, skip
      }
    }
    return opened;
  }

  public walletExists(primary_address: string): boolean {
    return this._settings.wallets.some(
      (w) => w.primary_address === primary_address,
    );
  }

  /**
   * add a new view wallet to settings and write its view key to env.
   * if the wallet already exists, updates it instead.
   */
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
    primary_address = primary_address.trim();
    view_key = view_key.trim();
    ScanSettingsOpened._validateAddress(primary_address);
    ScanSettingsOpened._validateViewKey(view_key);
    ScanSettingsOpened._validateWalletName(fields?.wallet_name);
    ScanSettingsOpened._validateWalletSlot(fields?.wallet_slot);
    ScanSettingsOpened._validateWalletRoute(fields?.wallet_route);
    ScanSettingsOpened._validateSubaddressIndex(fields?.subaddress_index);
    ScanSettingsOpened._validateHalted(fields?.halted);
    await this.reload();
    const existing = this.getWallet(primary_address);
    if (existing) {
      throw new Error(
        `wallet already exists: ${primary_address} in ${this._scan_settings_path}`,
      );
    }

    // write view key to env first
    await writeViewKeyToDotEnv(primary_address, view_key);
    const subaddress_index =
      fields?.subaddress_index ?? SUB_ADDRESS_INDEX_DEFAULT_VALUE;
    this._settings.wallets.push({
      primary_address,
      ...fields,
      subaddress_index,
    });

    await this._persist();
  }
  /**
   * add a new view wallet to settings and write its view key to env.
   * if the wallet already exists, updates it instead.
   */
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
    //   first part of writeWalletSecretsToDotEnv()

    const spend_key = await makeSpendKeyFromSeed(wallet_secret.toHex());
    const view_pair = await makeViewKey(spend_key);
    const primary_address = view_pair.mainnet_primary;
    ScanSettingsOpened._validateWalletName(fields?.wallet_name);
    ScanSettingsOpened._validateWalletSlot(fields?.wallet_slot);
    ScanSettingsOpened._validateWalletRoute(fields?.wallet_route);
    ScanSettingsOpened._validateSubaddressIndex(fields?.subaddress_index);
    ScanSettingsOpened._validateHalted(fields?.halted);
    await this.reload();
    const existing = this.getWallet(primary_address);
    if (existing) {
      throw new Error(
        `wallet already exists: ${primary_address} in ${this._scan_settings_path}`,
      );
    }
    // second part of   writeWalletSecretsToDotEnv(),

    await writeEnvLineToDotEnvRefresh(
      `vk${primary_address}`,
      view_pair.view_key,
    );
    await writeEnvLineToDotEnvRefresh(`sk${primary_address}`, spend_key);
    const subaddress_index =
      fields?.subaddress_index ?? SUB_ADDRESS_INDEX_DEFAULT_VALUE;
    this._settings.wallets.push({
      primary_address,
      ...fields,
      subaddress_index,
    });

    await this._persist();
  }

  /**
   * remove a wallet from settings by primary address.
   * does not remove the view key from env.
   */
  public async removeWallet(primary_address: string) {
    await this.reload();
    this._settings.wallets = this._settings.wallets.filter(
      (w) => w.primary_address !== primary_address,
    );
    await this._persist();
  }

  /**
   * update specific fields on an existing wallet.
   * set a field to null to unset it.
   */
  public async updateWallet(
    primary_address: string,
    fields: {
      wallet_name?: string | null;
      wallet_slot?: number | null;
      wallet_route?: string | null;
      subaddress_index?: number | null;
      halted?: boolean | null;
    },
  ) {
    await this.reload();
    const wallet = this.getWallet(primary_address);
    if (!wallet)
      throw new Error(
        `wallet not found: ${primary_address} in ${this._scan_settings_path}`,
      );
    ScanSettingsOpened._validateWalletName(fields.wallet_name);
    ScanSettingsOpened._validateWalletSlot(fields.wallet_slot);
    ScanSettingsOpened._validateSubaddressIndex(fields.subaddress_index);
    ScanSettingsOpened._validateWalletRoute(fields.wallet_route);
    ScanSettingsOpened._validateHalted(fields.halted);
    wallet.wallet_name = fields.wallet_name ?? wallet.wallet_name;
    wallet.wallet_slot = fields.wallet_slot ?? wallet.wallet_slot;
    wallet.wallet_route = fields.wallet_route ?? wallet.wallet_route;
    wallet.subaddress_index =
      fields.subaddress_index ?? wallet.subaddress_index;
    wallet.halted = fields.halted ?? wallet.halted;
    if (fields.halted === null) delete wallet.halted;
    if (fields.subaddress_index === null) delete wallet.subaddress_index;
    if (fields.wallet_route === null) delete wallet.wallet_route;
    if (fields.wallet_slot === null) delete wallet.wallet_slot;
    if (fields.wallet_name === null) delete wallet.wallet_name;

    await this._persist();
  }

  public async haltWallet(primary_address: string) {
    await this.updateWallet(primary_address, { halted: true });
  }

  public async unhaltWallet(primary_address: string) {
    await this.updateWallet(primary_address, { halted: false });
  }

  public async setWalletName(primary_address: string, name?: string) {
    await this.updateWallet(primary_address, { wallet_name: name ?? null });
  }

  public async setWalletSlot(primary_address: string, slot?: number) {
    await this.updateWallet(primary_address, { wallet_slot: slot ?? null });
  }

  public async setWalletRoute(primary_address: string, route?: string) {
    await this.updateWallet(primary_address, { wallet_route: route ?? null });
  }

  public async setSubaddressIndex(primary_address: string, index?: number) {
    await this.updateWallet(primary_address, {
      subaddress_index: index ?? null,
    });
  }

  /**
   * reread the settings file from disk and replace inmemory state.
   */
  public async reload() {
    const settings = await openScanSettingsFile(this._scan_settings_path);
    if (settings) {
      ScanSettingsOpened._validateLogOptions(
        settings.logs_include,
        settings.logs_exclude,
      );
      this._settings = settings;
    }
  }

  /**
   * validate that all entries in logs_include and logs_exclude
   * are valid function names from LOGGING_FUNCTIONS.
   * throws if any entry is invalid.
   */
  private static _validateLogOptions(
    logs_include?: PossibleLogs[] | null,
    logs_exclude?: PossibleLogs[] | null,
  ) {
    const valid = new Set<string>(LOGGING_FUNCTIONS);
    const invalid: string[] = [];
    for (const arr of [logs_include, logs_exclude]) {
      if (!arr) continue;
      for (const item of arr) {
        if (!valid.has(item)) {
          invalid.push(item);
        }
      }
    }
    if (invalid.length > 0) {
      throw new Error(
        `invalid log function(s): ${invalid.join(", ")}. ` +
          `valid options are: ${[...valid].join(", ")}`,
      );
    }
  }

  private static _validateAddress(address: string): void {
    if (!isValidMoneroAddress(address)) {
      throw new Error(`invalid monero address: ${address}`);
    }
  }

  private static _validateViewKey(key: string): void {
    if (!isValidMoneroPrivateKey(key)) {
      throw new Error(`invalid secret view key: ${key}`);
    }
  }

  private static _validateNodeUrl(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`invalid node URL: ${url}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    if (!parsed.hostname) {
      throw new Error(`invalid node URL, missing hostname: ${url}`);
    }
    return url;
  }

  private static _validateStartHeight(start_height: number | null): void {
    if (
      start_height !== null &&
      (typeof start_height !== "number" || start_height < 0)
    ) {
      throw new Error(
        `invalid start height: ${start_height}. must be null or a number >= 0`,
      );
    }
  }
  private static _validateCpuWorkerCount(
    cpu_worker_count: number | null,
  ): void {
    if (
      cpu_worker_count !== null &&
      (typeof cpu_worker_count !== "number" || cpu_worker_count < 0)
    ) {
      throw new Error(
        `invalid cpu_worker_count: ${cpu_worker_count}. must be null or a number >= 0`,
      );
    }
  }
  private static _validateMerchantConfirmations(
    merchant_confirmations: number | null,
  ): void {
    if (
      merchant_confirmations !== null &&
      (typeof merchant_confirmations !== "number" || merchant_confirmations < 0)
    ) {
      throw new Error(
        `invalid merchant_confirmations: ${merchant_confirmations}. must be null or a number >= 0`,
      );
    }
  }

  private static _validateWalletName(name?: string | null): void {
    if (name === undefined || name === null) return;
    if (name.length > 100) {
      throw new Error(
        `wallet name must be 100 characters or less, got ${name.length}`,
      );
    }
    if (!/^[a-zA-Z0-9 _.-]+$/.test(name)) {
      throw new Error(
        `wallet name must be alphanumeric with spaces, hyphens, underscores, or dots, got: ${name}`,
      );
    }
  }

  private static _validateWalletSlot(slot?: number | null): void {
    if (slot === undefined || slot === null) return;
    if (typeof slot !== "number" || slot < 0 || !Number.isInteger(slot)) {
      throw new Error(`wallet slot must be a number >= 0, got: ${slot}`);
    }
  }

  private static _validateSubaddressIndex(index?: number | null): void {
    if (index === undefined || index === null) return;
    if (typeof index !== "number" || index < 0 || !Number.isInteger(index)) {
      throw new Error(`subaddress index must be a number >= 0, got: ${index}`);
    }
  }

  private static _validateWalletRoute(route?: string | null): void {
    if (route === undefined || route === null) return;
    const result = walletRouteFromString(route);
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  private static _validateHalted(halted?: boolean | null): void {
    if (halted === undefined || halted === null) return;
    if (typeof halted !== "boolean") {
      throw new Error(`halted must be a boolean, got: ${halted}`);
    }
  }

  private _settings: ScanSettings;

  private constructor(
    settings: ScanSettings,
    private _scan_settings_path: string,
    private _pathPrefix: string,
  ) {
    this._settings = settings;
  }

  /**
   * write current in memory state to disk.
   */
  private async _persist() {
    await writeScanSettings(this._settings, this._scan_settings_path);
  }
}

function isValidMoneroAddress(address: string): boolean {
  // basic sanity check
  return (
    address.length >= 95 && address.length <= 106 && isAlphaNumeric(address)
  );
}

function isValidMoneroPrivateKey(key: string): boolean {
  return key.length === 64 && isAlphaNumeric(key);
}

function isAlphaNumeric(str: string) {
  return str.match(/^[a-z0-9]+$/i) !== null;
}
// strictly speaking according to the RFC 1035
// there is a limit of 63 chars per label
// and other rules like no leading or trailing hyphens, no dots in a row
function isValidDomainName(str: string) {
  if (!str || str.length === 0 || str.length > 253) {
    return false;
  }
  return str.match(/^[a-z0-9.\-_]+$/i) !== null;
}
// copied from seedphrase package to not introduce a dependency
export function walletRouteFromString(input: string) {
  const parts = input.split("/");

  if (parts.length < 1 || !parts[0]) {
    return { ok: false, error: "missing identity" };
  }
  if (parts.length < 2 || !parts[1]) {
    return { ok: false, error: "missing domain" };
  }
  if (parts.length < 3 || !parts[2]) {
    return { ok: false, error: "missing wallet_type" };
  }
  if (parts.length < 4 || !parts[3]) {
    return { ok: false, error: "missing wallet_slot" };
  }
  if (parts.length > 4) {
    return {
      ok: false,
      error: "wallet route should only have 4 parts separated by /",
    };
  }

  const [identity, domain, wallet_type, wallet_slot] = parts;

  if (
    wallet_type !== "single" &&
    wallet_type !== "sa_multi" &&
    wallet_type !== "pl_multi"
  ) {
    return { ok: false, error: `invalid wallet_type: "${wallet_type}"` };
  }

  if (Number.isNaN(parseInt(wallet_slot))) {
    return { ok: false, error: `invalid wallet_slot: "${wallet_slot}"` };
  }
  if (parseInt(wallet_slot) < 0) {
    return { ok: false, error: `invalid wallet_slot: "${wallet_slot} < 0"` };
  }

  if (!isAlphaNumeric(identity)) {
    return {
      ok: false,
      error: `invalid identity, not alpha numeric: "${identity}"`,
    };
  }
  if (!isValidDomainName(domain)) {
    return {
      ok: false,
      error: `invalid domain, : "${domain}"`,
    };
  }

  return {
    ok: true,
    route: { identity, domain, wallet_type, wallet_slot },
  };
}
