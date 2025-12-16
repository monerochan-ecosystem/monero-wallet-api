export const scanSettingsStoreNameDefault = "ScanSettings.json";
export type ScanSetting = {
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
// to be used by scanWithCacheFromSettings() function on ViewPairs instance
/**
 * Writes scan settings to the default or specified storage file in json.
 *
 * @example
 * ```
 * const settings: ScanSettings = {
 *   wallets: [{
 *     primary_address: "5dsf...",
 *     secret_view_key: "jklsdf...",
 *     spend_private_key: "9e561...",
 *     start_height: 1741707,
 *   }],
 *   node_urls: ["https://monerooo.roooo"]
 * };
 * await writeScanSettings(settings);
 * ```
 *
 * @param scan_settings - The complete {@link ScanSettings} configuration to persist.
 * @param settingsStorePath - Optional path for the settings file. Defaults to `scanSettingsStoreNameDefault`.
 * @returns A promise that resolves when the file is successfully written.
 * @throws Will throw if file writing fails (e.g., permissions, disk space).
 */
export async function writeScanSettings(
  scan_settings: ScanSettings,
  settingsStorePath: string = scanSettingsStoreNameDefault
) {
  return await Bun.write(
    settingsStorePath,
    JSON.stringify(scan_settings, null, 2)
  );
}
/**
 * Reads scan settings from the default or specified storage file.
 *
 * @example
 * ```
 * const settings = await readScanSettings();
 * if (settings) {
 *   console.log(settings.wallets?.primary_address);
 * }
 * ```
 *
 * @param settingsStorePath - Path to the settings file. Defaults to `scanSettingsStoreNameDefault`.
 * @returns The parsed {@link ScanSettings} object if file exists and is valid JSON, otherwise `undefined`.
 */
export async function readScanSettings(
  settingsStorePath: string = scanSettingsStoreNameDefault
) {
  const jsonString = await Bun.file(settingsStorePath)
    .text()
    .catch(() => undefined);
  return jsonString ? (JSON.parse(jsonString) as ScanSettings) : undefined;
}
