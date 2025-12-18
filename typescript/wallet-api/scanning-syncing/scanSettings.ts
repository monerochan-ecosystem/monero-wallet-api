import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";

export const SCAN_SETTINGS_STORE_NAME_DEFAULT = "ScanSettings.json";
export type ScanSetting = {
  primary_address: string;
  start_height: number;
  halted?: boolean;
  stop_height?: number | null;
};
export type WriteScanSettingParams = {
  primary_address: string;
  start_height?: number;
  halted?: boolean;
  stop_height?: number | null;
  scan_settings_path?: string; // write your settings to a different path
  node_url?: string;
};
export type ScanSettingOpened = {
  primary_address: string;
  start_height: number;
  secret_view_key?: string;
  halted?: boolean;
  spend_private_key?: string;
  stop_height?: number | null;
};
export type ScanSettings = {
  wallets: (ScanSetting | undefined)[]; // ts should treat arrays like this by default. (value|undefined)[]
  node_urls: string[];
};
export type ScanSettingsOpened = {
  wallets: (ScanSettingOpened | undefined)[]; // ts should treat arrays like this by default. (value|undefined)[]
  node_urls: string[];
};
// to be used by scanWithCacheFromSettings() function on ViewPairs instance
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
  return await Bun.write(
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
    const primary_address = wallet!.primary_address;
    const secret_view_key = Bun.env["vk" + primary_address];
    const spend_private_key = Bun.env["sk" + primary_address];
    openScanSettings.wallets[i]!.secret_view_key = secret_view_key;
    openScanSettings.wallets[i]!.spend_private_key = spend_private_key;
  }
  return openScanSettings;
}
export async function readWalletFromScanSettings(
  primary_address: string,
  scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT
) {
  const scanSettings = await openScanSettingsFile(scan_settings_path);
  if (!scanSettings) return undefined;
  return scanSettings.wallets.find(
    (wallet) => wallet?.primary_address === primary_address
  );
}

export async function writeWalletToScanSettings(
  params: WriteScanSettingParams
) {
  if (!params.node_url) params.node_url = LOCAL_NODE_DEFAULT_URL;
  if (!params.scan_settings_path)
    params.scan_settings_path = SCAN_SETTINGS_STORE_NAME_DEFAULT;
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
            stop_height: params.stop_height,
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
    });
  } else {
    // wallet already exists
    const wallet = scanSettings.wallets[already_has_settings];
    if (wallet) {
      wallet.start_height = params.start_height || wallet.start_height;
      wallet.halted = params.halted;
      wallet.stop_height = params.stop_height;
    }
  }

  return await Bun.write(
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
