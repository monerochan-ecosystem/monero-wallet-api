import type { BlockInfo, ErrorResponse, ScanResult } from "../../api";
import { readDir } from "../../io/readDir";
import type { ScanSetting } from "../scanSettings";
import { readCacheFileDefaultLocation } from "./scanCache";

export async function writeGetblocksBinBuffer(
  getBlocksBinResponseContent: Uint8Array,
  block_infos: BlockInfo[],
  pathPrefix?: string
) {
  if (!block_infos.length) return;

  return await Bun.write(
    `${pathPrefix ?? ""}getblocksbinbuffer/${Date.now()}-${
      block_infos[0].block_height
    }-${block_infos[block_infos.length - 1].block_height}-getblocks.bin`,
    getBlocksBinResponseContent
  );
}
export type GetBlocksBinBufferItem = {
  start: number;
  end: number;
  filename: string;
  date: string;
};
export async function readGetblocksBinBuffer(
  current_height: number,
  pathPrefix?: string
): Promise<GetBlocksBinBufferItem[]> {
  const bufferItems = await readGetblocksBinBufferItems(pathPrefix);

  const start_buffer =
    bufferItems.find(
      (r) => current_height >= r.start && current_height <= r.end
    ) ?? null;
  if (start_buffer)
    return [
      start_buffer,
      ...bufferItems.filter((r) => r.date > start_buffer?.date),
    ];
  return [];
}
// Factory to create a slave generator, fed through next(blocksBin)
export function createSlaveFeeder(
  current_height: number,
  foodFromMaster: FoodFromMaster,
  pathPrefix?: string
): BlocksGenerator {
  const getBlocksbinBuffer: GetBlocksBinBufferItem[] = [];

  return (async function* () {
    while (true) {
      while (getBlocksbinBuffer.length > 0) {
        const blocksBinItem = getBlocksbinBuffer.shift()!;
        current_height = blocksBinItem.end;
        yield new Uint8Array(
          await Bun.file(blocksBinItem.filename).arrayBuffer()
        );
      } // the buffer is persisted to disk / indexeddb so that a multiwalletscan can be interrupted without the slaves getting holes
      await foodFromMaster();
      getBlocksbinBuffer.push(
        ...(await readGetblocksBinBuffer(current_height, pathPrefix))
      );
    }
  })();
}

export type BlocksGenerator = AsyncGenerator<Uint8Array<ArrayBufferLike>>;
export type FoodFromMaster = () => Promise<void>;
export type SlaveInit = {
  nonHaltedWallets: ScanSetting[];
  foodFromMaster: FoodFromMaster;
};
export type MasterInit = { master: true; nonHaltedWallets: ScanSetting[] };
export type MasterSlaveInit = MasterInit | SlaveInit;
declare module "bun" {
  interface BunFile {
    delete(): Promise<void>;
  }
}
export async function trimGetBlocksBinBuffer(
  nonHaltedWallets: ScanSetting[],
  pathPrefix?: string
) {
  const snail = Math.min(
    ...(
      await Promise.all(
        nonHaltedWallets.map(
          async (wallet) =>
            (
              await readCacheFileDefaultLocation(
                wallet.primary_address,
                pathPrefix
              )
            )?.scanned_ranges[0]?.end
        )
      )
    ).filter((x) => x !== undefined)
  );
  // if all wallets have  higher start than end of blocksbufferitem, delete
  const bufferItems = await readGetblocksBinBufferItems(pathPrefix);

  for (const bufferItem of bufferItems) {
    if (bufferItem.end < snail) {
      await Bun.file(
        `${pathPrefix ?? ""}getblocksbinbuffer/${bufferItem.filename}`
      ).delete();
    }
  }
}
export async function readGetblocksBinBufferItems(
  pathPrefix?: string
): Promise<GetBlocksBinBufferItem[]> {
  const bufferItems = await readDir(
    `${pathPrefix ?? ""}getblocksbinbuffer/`
  ).catch(() => []);
  const ranges = [];
  for (const filename of bufferItems) {
    const [date, start, end] = filename.split("-");
    ranges.push({
      start: parseInt(start),
      end: parseInt(end),
      filename,
      date,
    });
  }
  return ranges;
}
export async function updateGetBlocksBinBuffer(
  masterSlaveInit: MasterSlaveInit | undefined,
  firstResponse: Uint8Array,
  result: ScanResult | ErrorResponse | undefined,
  pathPrefix?: string
) {
  if (masterSlaveInit && "master" in masterSlaveInit) {
    if (result && "block_infos" in result)
      await writeGetblocksBinBuffer(
        firstResponse,
        result.block_infos,
        pathPrefix
      ); // feed the slaves

    return await trimGetBlocksBinBuffer(
      masterSlaveInit.nonHaltedWallets,
      pathPrefix
    );
  }
}
