import { atomicWrite } from "../api";
import { SCAN_SETTINGS_STORE_NAME_DEFAULT } from "./scanSettings";
export type ConnectionStatusOptions =
  | "OK"
  | "partial_read"
  | "connection_failed"
  | "no_connection_yet"
  | "catastrophic_reorg";
export type ConnectionStatus = {
  last_packet: {
    status: ConnectionStatusOptions;
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

export async function writeConnectionStatusFile(
  status: ConnectionStatusOptions,
  node_url: string,
  bytes_read: number = 0,
  scan_settings_path?: string,
) {
  const connectionStatus: ConnectionStatus = {
    last_packet: {
      status,
      bytes_read,
      node_url,
      timestamp: new Date().toISOString(),
    },
  };
  return await atomicWrite(
    connectionStatusFilePath(scan_settings_path),
    JSON.stringify(connectionStatus, null, 2),
  );
}

export async function readWriteConnectionStatusFile(
  writeCB: (cs: ConnectionStatus | undefined) => ConnectionStatus | undefined,
  scan_settings_path?: string,
) {
  const connectionStatus =
    await readConnectionStatusDefaultLocation(scan_settings_path);
  const cb = await writeCB(connectionStatus);
  if (typeof cb === "undefined") return;
  return await writeConnectionStatusFile(
    cb.last_packet.status,
    cb.last_packet.node_url,
    cb.last_packet.bytes_read,
    scan_settings_path,
  );
}
