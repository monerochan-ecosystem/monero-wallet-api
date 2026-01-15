import { atomicWrite } from "../io/atomicWrite";
import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";

export const SCAN_SETTINGS_STORE_NAME_DEFAULT = "ScanSettings.json";
export type ScanSetting = {
  primary_address: string;
  start_height: number;
  subaddress_index?: number;
  halted?: boolean;
  node_url?: string;
};
export type WriteScanSettingParams = {
  primary_address: string;
  start_height?: number;
  halted?: boolean;
  scan_settings_path?: string; // write your settings to a different path
  node_url?: string;
};
export type ScanSettingOpened = {
  primary_address: string;
  start_height: number;
  node_url: string;
  secret_view_key?: string;
  halted?: boolean;
  secret_spend_key?: string;
};
export type ScanSettings = {
  wallets: ScanSetting[];
  node_urls: string[];
};
export type ScanSettingsOpened = {
  wallets: (ScanSettingOpened | undefined)[]; // ts should treat arrays like this by default. (value|undefined)[]
  node_urls: string[];
};
/**
 * Writes scan settings to the default or specified storage file in json.
 *
 * @example
 * ```
 * const settings: ScanSettings = {
 *   wallets: [{
 *     primary_address: "5dsf...",
 *     start_height: 1741707,
 *   }],
 *   node_urls: ["https://monerooo.roooo"]
 * };
 * await writeScanSettings(settings);
 * ```
 *
 * @param scan_settings - The complete {@link ScanSettings} configuration to persist.
 * @param settingsStorePath - Optional path for the settings file. Defaults to `SCAN_SETTINGS_STORE_NAME_DEFAULT`.
 * @returns A promise that resolves when the file is successfully written.
 * @throws Will throw if file writing fails (e.g., permissions, disk space).
 */
export async function writeScanSettings(
  scan_settings: ScanSettings,
  settingsStorePath: string = SCAN_SETTINGS_STORE_NAME_DEFAULT
) {
  return await atomicWrite(
    settingsStorePath,
    JSON.stringify(scan_settings, null, 2)
  );
}
/**
 * Reads scan settings from the default or specified storage file.
 * secret_view_key and spend_private_key are read from environment variables
 *
 * @example
 * ```
 * const settings = await readScanSettings();
 * if (settings) {
 *   console.log(settings.wallets?.primary_address);
 * }
 * ```
 *
 * @param settingsStorePath - Path to the settings file. Defaults to `SCAN_SETTINGS_STORE_NAME_DEFAULT`.
 * @returns The parsed {@link ScanSettings} object if file exists and is valid JSON, otherwise `undefined`.
 */
export async function readScanSettings(
  scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT
): Promise<ScanSettingsOpened | undefined> {
  const scanSettings = await openScanSettingsFile(scan_settings_path);
  const openScanSettings = Object.assign(
    {},
    scanSettings
  ) as ScanSettingsOpened;
  if (!scanSettings) return undefined;
  for (const [i, wallet] of scanSettings.wallets.entries()) {
    if (!wallet.primary_address)
      throw new Error(
        "The entry ${i} in the wallet settings list in ${scan_settings_path} has no primary address"
      );
    const walletWithKeys = walletSettingsPlusKeys(wallet);
    openScanSettings.wallets[i]!.secret_view_key =
      walletWithKeys.secret_view_key;
    openScanSettings.wallets[i]!.secret_spend_key =
      walletWithKeys.secret_spend_key;
  }
  return openScanSettings;
}
export function readPrivateSpendKeyFromEnv(primary_address: string) {
  return Bun.env["sk" + primary_address];
}
export function readPrivateViewKeyFromEnv(primary_address: string) {
  return Bun.env["vk" + primary_address];
}
export async function readWalletFromScanSettings(
  primary_address: string,
  scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT
): Promise<ScanSetting | undefined> {
  const scanSettings = await openScanSettingsFile(scan_settings_path);
  if (!scanSettings) return undefined;
  const walletSettings = scanSettings.wallets.find(
    (wallet) => wallet?.primary_address === primary_address
  );
  if (!walletSettings)
    throw new Error(
      `wallet not found in settings. did you call openwallet with the right params?
      Either wrong file name supplied to params.scan_settings_path: ${scan_settings_path}
      Or wrong primary_address supplied params.primary_address: ${primary_address}`
    );
  return {
    ...walletSettings,
    node_url: scanSettings.node_urls[0],
  };
}
export function walletSettingsPlusKeys(
  wallet_settings: ScanSetting,
  secret_view_key?: string,
  secret_spend_key?: string
) {
  // read secret_view_key and secret_spend_key from env
  if (!secret_view_key)
    secret_view_key = Bun.env[`vk${wallet_settings.primary_address}`];
  if (!secret_view_key)
    throw (
      "no secret_view_key provided and not found in env for address: " +
      wallet_settings.primary_address
    );
  if (!secret_spend_key)
    secret_spend_key = Bun.env[`sk${wallet_settings.primary_address}`];
  if (!secret_spend_key)
    throw (
      "no secret_spend_key provided and not found in env for address: " +
      wallet_settings.primary_address
    );

  return {
    ...wallet_settings,
    secret_view_key,
    secret_spend_key,
  };
}

export async function writeWalletToScanSettings(
  params: WriteScanSettingParams
) {
  if (!params.node_url) params.node_url = LOCAL_NODE_DEFAULT_URL;
  if (!params.scan_settings_path)
    params.scan_settings_path = SCAN_SETTINGS_STORE_NAME_DEFAULT;
  if (!params.primary_address)
    throw new Error(
      "no primary address provided to writeWalletToScanSettings()"
    );
  const scanSettings = await openScanSettingsFile(params.scan_settings_path);
  if (!scanSettings) {
    // case: no scan settings exist yet
    return await writeScanSettings(
      {
        wallets: [
          {
            primary_address: params.primary_address,
            start_height: params.start_height || 0,
            halted: params.halted,
          },
        ],
        node_urls: [params.node_url],
      },
      params.scan_settings_path
    );
  }

  const already_has_settings = scanSettings.wallets.findIndex(
    (wallet) => wallet?.primary_address === params.primary_address
  );
  if (already_has_settings === -1) {
    // wallet does not exist yet in settings
    scanSettings.wallets.push({
      primary_address: params.primary_address,
      start_height: params.start_height || 0,
      halted: params.halted,
    });
  } else {
    // wallet already exists
    const wallet = scanSettings.wallets[already_has_settings];
    if (wallet) {
      wallet.start_height = params.start_height || wallet.start_height;
      wallet.halted = params.halted;
    }
  }

  return await atomicWrite(
    params.scan_settings_path,
    JSON.stringify(scanSettings, null, 2)
  );
}
export async function openScanSettingsFile(
  scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT
): Promise<ScanSettings | undefined> {
  const jsonString = await Bun.file(scan_settings_path)
    .text()
    .catch(() => undefined);

  return jsonString ? (JSON.parse(jsonString) as ScanSettings) : undefined;
}

export async function openNonHaltedWallets(
  scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT
): Promise<ScanSetting[]> {
  const scan_settings = await openScanSettingsFile(scan_settings_path);
  if (!scan_settings)
    throw new Error(
      "no scan settings file found at path: " + scan_settings_path
    );
  if (!scan_settings?.wallets) throw new Error("no wallets in scan settings");
  const nonHaltedWallets = scan_settings.wallets.filter(
    (wallet) => !wallet?.halted
  );
  if (!nonHaltedWallets.length)
    throw new Error("no non halted wallets in scan settings");
  return nonHaltedWallets;
}
