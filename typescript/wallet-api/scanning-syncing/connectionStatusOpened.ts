import {
  readConnectionStatusFile,
  connectionStatusFilePath,
  type ConnectionStatus,
} from "../api";

export class ConnectionStatusOpened {
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _cached: ConnectionStatus | null = null;
  private _prevConnected = false;
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
    return this._cached?.last_packet?.daemon_height;
  }

  private async _poll() {
    this._cached =
      (await readConnectionStatusFile(this._path).catch(() => null)) || null;

    const now = this.isConnected;
    if (now !== this._prevConnected) {
      this._prevConnected = now;
      this._onChange?.(this._cached);
    }
  }
}
