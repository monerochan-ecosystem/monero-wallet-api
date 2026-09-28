import {
  atomicWrite,
  type BlockInfo,
  type CacheRange,
  type ReorgInfo,
} from "../api";
import { SCAN_SETTINGS_STORE_NAME_DEFAULT } from "../api";
export type ConnectionStatusOptions =
  | "OK"
  | "partial_read"
  | "connection_failed"
  | "blocks_buffer_full"
  | "no_connection_yet"
  | "catastrophic_reorg";
export type ConnectionSatusLastPacket = {
  status: ConnectionStatusOptions;
  bytes_read: number;
  node_url: string;
  timestamp: string;
  daemon_height?: number;
};
export type ConnectionStatusSync = {
  reorg_info?: ReorgInfo;
  scanned_ranges: CacheRange[]; // list of block height ranges that have been scanned [0].start, [length-1].end <-- last scanned height
  daemon_height: number;
  current_scan_height: number; //  derived from:  scan_settings start_height + end height of scanned_range that start height is in scanned_ranges
  eta: string;
  timestamp: string;
};
export type ConnectionStatus = {
  last_packet: ConnectionSatusLastPacket;
  sync: ConnectionStatusSync;
};

// wallet progress write: always set scan fields; only replace eta when a new one is provided
// so a missing eta does not wipe / flicker the previous value.
export function applyWalletScanProgress(
  cs: ConnectionStatus,
  progress: {
    current_scan_height: number;
    scanned_ranges?: CacheRange[];
    daemon_height?: number;
    eta?: string;
  },
) {
  cs.sync.current_scan_height = progress.current_scan_height;
  if (progress.scanned_ranges) {
    cs.sync.scanned_ranges = progress.scanned_ranges;
  }
  if (typeof progress.daemon_height === "number") {
    cs.sync.daemon_height = progress.daemon_height;
  }
  if (progress.eta !== undefined) {
    cs.sync.eta = progress.eta;
  }
  const now = new Date().toISOString();
  cs.sync.timestamp = now;
  // finished batch is a heartbeat so buffer-full catch-up does not look dead
  if (cs.last_packet) {
    cs.last_packet.timestamp = now;
  }
}

// idle tip: ok packet has daemon height but no work item wrote sync yet
export function applyLastPacket(
  cs: ConnectionStatus,
  packet: ConnectionSatusLastPacket,
) {
  cs.last_packet = packet;
  if (packet.status === "OK" && typeof packet.daemon_height === "number") {
    cs.sync.daemon_height = packet.daemon_height;
    if (!cs.sync.current_scan_height) {
      cs.sync.current_scan_height = packet.daemon_height;
    }
  }
}

export function isConnectedFromStatus(
  cs: ConnectionStatus | null | undefined,
): boolean {
  if (!cs?.last_packet) return false;
  const { status, timestamp } = cs.last_packet;
  // fetch paused on purpose while cpu drains the buffer. not a drop.
  if (status === "blocks_buffer_full") return true;
  if (status !== "OK") return false;
  // catching up: slow get_blocks_bin is not a drop. 10s rule is for tip idle only.
  const behind =
    cs.sync.daemon_height > 0 &&
    cs.sync.current_scan_height > 0 &&
    cs.sync.daemon_height - cs.sync.current_scan_height > 100;
  if (behind) return true;
  if (!timestamp) return false;
  const age = Date.now() - new Date(timestamp).getTime();
  return age >= 0 && age <= 10_000;
}

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

export function emptyConnectionStatus(
  overrides?: Partial<ConnectionStatus>,
): ConnectionStatus {
  const defaultStatus: ConnectionStatus = {
    last_packet: {
      status: "no_connection_yet",
      bytes_read: 0,
      node_url: "",
      timestamp: new Date().toISOString(),
    },
    sync: {
      scanned_ranges: [],
      daemon_height: 0,
      current_scan_height: 0,
      eta: "00:00",
      timestamp: new Date().toISOString(),
    },
  };
  return overrides ? { ...defaultStatus, ...overrides } : defaultStatus;
}

export function connectionStatusFilePath(
  scan_settings_path: string = SCAN_SETTINGS_STORE_NAME_DEFAULT,
) {
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
  writeCB: (cs: ConnectionStatus) => void,
  scan_settings_path?: string,
) {
  let connectionStatus =
    await readConnectionStatusDefaultLocation(scan_settings_path);
  if (!connectionStatus) connectionStatus = emptyConnectionStatus();
  await writeCB(connectionStatus);
  await writeConnectionStatusFile(connectionStatus, scan_settings_path);
  return connectionStatus;
}
/**
 * read the connection status from disk (typical /path/to/ConnectionStatus-ScanSettings.json)
 * and persist empty inital status if not found
 * @param scan_settings_path  path to the scan settings file /path/to/ScanSettings.json
 * @returns connection status or empty initalized connection status
 */
export async function readOrInitConnectionStatus(
  scan_settings_path?: string,
): Promise<ConnectionStatus> {
  const cs = await readConnectionStatusFile(
    connectionStatusFilePath(scan_settings_path),
  );
  if (typeof cs === "undefined") {
    const emptyInitial = emptyConnectionStatus();
    await writeConnectionStatusFile(emptyInitial, scan_settings_path);
    return emptyInitial;
  }
  return cs;
}
