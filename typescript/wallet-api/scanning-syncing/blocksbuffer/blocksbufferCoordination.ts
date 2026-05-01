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

export type SetupBlocksBufferGeneratorParams = {
  nodeUrl: string;
  startHeight: number;
  anchor_range?: CacheRange;
  stopSync?: AbortSignal;
  maxBufferItems?: number;
};
export async function setupBlocksBufferGenerator(
  params: SetupBlocksBufferGeneratorParams,
) {
  const blocksBuffer: GetBlocksBinBufferItem[] = [];
  const connection_status: ConnectionStatus =
    await readOrInitConnectionStatus();

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
  scanSettingsPath: string,
) {
  if (event === "blocks_buffer_changed") return;
  if ("status" in event) {
    await readWriteConnectionStatusFile((cs2) => {
      cs2.last_packet = event;
    }, scanSettingsPath);
    if (event.status === "catastrophic_reorg") {
      console.log("[blocksbufferCoordinator] catastrophic reorg, stopping");
      throw new CatastrophicReorgError(
        "[blocksbufferCoordinator] catastrophic reorg, stopping",
      );
    }
  }
  if ("scanned_ranges" in event) {
    //TODO: only write this to disk after blocks_buffer_changed has been handled by wallets.
    //look for same comment in blocksBufferFetchLoop.ts
    await readWriteConnectionStatusFile((cs2) => {
      cs2.sync = event;
    }, scanSettingsPath);
  }
}
