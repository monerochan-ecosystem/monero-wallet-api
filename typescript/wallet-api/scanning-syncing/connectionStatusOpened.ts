import {
  readConnectionStatusFile,
  connectionStatusFilePath,
  type ConnectionStatus,
} from "../api";

export class ConnectionStatusOpened {
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _cached: ConnectionStatus | null = null;
  private _prevConnected = false;
  // notify when sync progress fields change, not only connect flip
  private _prevSyncKey = "";
  private _path: string;

  constructor(
    scan_settings_path: string,
    private _onChange?: ((status: ConnectionStatus | null) => void) | null,
  ) {
    this._path = connectionStatusFilePath(scan_settings_path);
  }

  async watch(intervalMs = 2500) {
    if (this._timer) return;
    await this._poll();
    this._timer = setInterval(() => this._poll(), intervalMs);
  }

  unwatch() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  get connectionStatus(): ConnectionStatus | null {
    return this._cached;
  }

  get isConnected(): boolean {
    const cs = this._cached;
    if (!cs?.last_packet) return false;
    const { status, timestamp } = cs.last_packet;
    if (status !== "OK" && status !== "blocks_buffer_full") return false;
    if (!timestamp) return false;
    const age = Date.now() - new Date(timestamp).getTime();
    return age >= 0 && age <= 10_000;
  }

  get daemonHeight(): number | undefined {
    return this._cached?.sync?.daemon_height;
  }

  private _syncKey(cs: ConnectionStatus | null): string {
    const s = cs?.sync;
    if (!s) return "";
    return [
      s.daemon_height ?? "",
      s.current_scan_height ?? "",
      s.eta ?? "",
      s.timestamp ?? "",
    ].join("|");
  }

  private async _poll() {
    this._cached =
      (await readConnectionStatusFile(this._path).catch(() => null)) || null;

    const now = this.isConnected;
    const syncKey = this._syncKey(this._cached);
    const connectedChanged = now !== this._prevConnected;
    const syncChanged = syncKey !== this._prevSyncKey;
    this._prevConnected = now;
    this._prevSyncKey = syncKey;
    if (connectedChanged || syncChanged) {
      this._onChange?.(this._cached);
    }
  }
}
