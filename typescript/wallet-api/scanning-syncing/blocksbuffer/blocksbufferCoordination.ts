import {
  blocksBufferFetchLoop,
  readWriteConnectionStatusFile,
  type GetBlocksBinBufferItem,
  type ConnectionStatus,
  type BlocksBufferLoopResult,
  CatastrophicReorgError,
  readOrInitConnectionStatus,
  type CacheRange,
} from "../../api";
import { log } from "../../io/logging";

export type SetupBlocksBufferGeneratorParams = {
  nodeUrl: string;
  startHeight: number;
  anchor_range?: CacheRange;
  stopSync?: AbortSignal;
  maxBufferItems?: number;
  scanSettingsPath?: string;
};
export async function setupBlocksBufferGenerator(
  params: SetupBlocksBufferGeneratorParams,
) {
  const blocksBuffer: GetBlocksBinBufferItem[] = [];
  const connection_status: ConnectionStatus = await readOrInitConnectionStatus(
    params.scanSettingsPath,
  );

  const generator = blocksBufferFetchLoop(
    params.nodeUrl,
    params.startHeight,
    blocksBuffer,
    connection_status,
    params.maxBufferItems,
    params.anchor_range,
    params.stopSync,
  );

  return { generator, blocksBuffer, connection_status };
}

export async function handleConnectionStatusChanges(
  event: BlocksBufferLoopResult,
  scanSettingsPath?: string,
) {
  if ("local_uuid" in event && typeof event.local_uuid === "string") return;
  if ("status" in event) {
    await readWriteConnectionStatusFile((cs2) => {
      cs2.last_packet = event;
    }, scanSettingsPath);
    if (event.status === "catastrophic_reorg") {
      log("handleConnectionStatusChanges", "catastrophic reorg, stopping");
      throw new CatastrophicReorgError(
        "[blocksbufferCoordinator] catastrophic reorg, stopping",
      );
    }
  }
  if ("scanned_ranges" in event) {
    await readWriteConnectionStatusFile((cs2) => {
      cs2.sync = {
        ...event,
        // preserve eta and current_scan_height from file
        eta: cs2.sync.eta || event.eta,
        current_scan_height:
          cs2.sync.current_scan_height || event.current_scan_height,
      };
    }, scanSettingsPath);
  }
}
