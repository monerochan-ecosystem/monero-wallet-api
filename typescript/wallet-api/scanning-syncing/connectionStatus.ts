import { SCAN_SETTINGS_STORE_NAME_DEFAULT } from "./scanSettings";

export type ConnectionStatus = {
  last_packet: {
    status: "OK" | "partial_read" | "connection_failed" | "no_connection_yet";
    bytes_read: number;
    node_url: string;
    timestamp: string;
  };
};

export const DEFAULT_CONNECTION_STATUS_PREFIX = "ConnectionStatus-";

export function connectionStatusFilePath(scan_settings_path?: string) {
  if (!scan_settings_path)
    scan_settings_path = SCAN_SETTINGS_STORE_NAME_DEFAULT;
  return `${DEFAULT_CONNECTION_STATUS_PREFIX}${scan_settings_path}`;
}

export async function readConnectionStatusDefaultLocation(
  scan_settings_path?: string,
): Promise<ConnectionStatus | undefined> {
  return await readConnectionStatusFile(
    connectionStatusFilePath(scan_settings_path),
  );
}
export async function readConnectionStatusFile(
  connectionStatusFilePath: string,
): Promise<ConnectionStatus | undefined> {
  const jsonString = await Bun.file(connectionStatusFilePath)
    .text()
    .catch(() => undefined);
  return jsonString ? (JSON.parse(jsonString) as ConnectionStatus) : undefined;
}
