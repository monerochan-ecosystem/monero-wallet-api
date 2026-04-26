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
  sync?: {
    daemon_height: number;
    current_scan_height: number;
    eta: string;
    timestamp: string;
  };
};

export const DEFAULT_CONNECTION_STATUS_PREFIX = "ConnectionStatus-";

export function msToHHMM(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return "00:00";
  }

  const paddedHours = String(hours).padStart(2, "0");
  const paddedMinutes = String(remainingMinutes).padStart(2, "0");

  return `${paddedHours}:${paddedMinutes}`;
}

export async function updateSyncETA(
  daemon_height: number,
  current_scan_height: number,
  last_height: number | null,
  last_timestamp: number | null,
  scan_settings_path?: string,
): Promise<{ last_height: number; last_timestamp: number }> {
  const blocks_till_tip = daemon_height - current_scan_height;
  let blocks_since_last_update: number | null = null;
  let duration: number | null = null;

  if (typeof last_height === "number") {
    blocks_since_last_update = current_scan_height - last_height;
  }

  if (typeof last_timestamp === "number") {
    duration = Date.now() - last_timestamp;
  }

  let eta = "00:00";
  if (
    blocks_since_last_update !== null &&
    duration !== null &&
    duration > 0 &&
    blocks_till_tip > 0
  ) {
    const blocks_per_ms = blocks_since_last_update / duration;
    const eta_ms = blocks_till_tip / blocks_per_ms;
    eta = msToHHMM(eta_ms);
  }

  await readWriteConnectionStatusFile((cs) => {
    if (!cs) return undefined;
    cs.sync = {
      daemon_height,
      current_scan_height,
      eta,
      timestamp: new Date().toISOString(),
    };
    return cs;
  }, scan_settings_path);

  return { last_height: current_scan_height, last_timestamp: Date.now() };
}

export function connectionStatusFilePath(scan_settings_path?: string) {
  if (!scan_settings_path)
    scan_settings_path = SCAN_SETTINGS_STORE_NAME_DEFAULT;
  const parts = scan_settings_path.split("/");
  const basename = parts.pop()!;
  const dir = parts.join("/");
  const prefix = dir ? `${dir}/` : "";
  return `${prefix}${DEFAULT_CONNECTION_STATUS_PREFIX}${basename}`;
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
  connectionStatus: ConnectionStatus,
  scan_settings_path?: string,
) {
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
  return await writeConnectionStatusFile(cb, scan_settings_path);
}
