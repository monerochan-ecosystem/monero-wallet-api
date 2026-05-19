import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";
import type { LogSetting, PossibleLogs } from "../io/logging";
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

export type ScanSettingsOpenedCreateParams = {
  scan_settings_path?: string;
  pathPrefix?: string;
};

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
    }

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
    this._settings.node_url = node_url;
    await this._persist();
  }

  public async setStartHeight(start_height: number | null) {
    await this.reload();
    this._settings.start_height = start_height;
    await this._persist();
  }

  public async setMerchantConfirmations(merchant_confirmations: number | null) {
    await this.reload();
    this._settings.merchant_confirmations = merchant_confirmations;
    await this._persist();
  }

  public async setCpuWorkerCount(cpu_worker_count: number | undefined) {
    await this.reload();
    this._settings.cpu_worker_count = cpu_worker_count;
    await this._persist();
  }

  public async setLogSettings(
    logs?: LogSetting,
    logs_include?: PossibleLogs[],
    logs_exclude?: PossibleLogs[],
  ) {
    await this.reload();
    this._settings.logs = logs;
    this._settings.logs_include = logs_include;
    this._settings.logs_exclude = logs_exclude;
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
    await this.reload();
    const existing = this.getWallet(primary_address);
    if (existing) {
      throw new Error(
        `wallet already exists: ${primary_address} in ${this._scan_settings_path}`,
      );
    }
    primary_address = primary_address.trim();
    view_key = view_key.trim();

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
      this._settings = settings;
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
