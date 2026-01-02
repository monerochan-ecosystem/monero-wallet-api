import type { BlockInfo, GetBlocksBinRequest, ViewPair } from "../../api";
import { atomicWrite } from "../../io/atomicWrite";
import { readDir } from "../../io/readDir";
import type { ScanSetting } from "../scanSettings";
import { readCacheFileDefaultLocation, type CacheRange } from "./scanCache";

export async function writeGetblocksBinBuffer(
  getBlocksBinResponseContent: Uint8Array,
  block_infos: BlockInfo[],
  pathPrefix?: string
) {
  if (!block_infos.length) return;
  const start = block_infos[0].block_height;
  const end = block_infos.at(-1)?.block_height;
  const block_hash = block_infos.at(-1)?.block_hash;
  const bufferItems = await readGetblocksBinBufferItems(pathPrefix);
  if (bufferItems.find((bi) => bi.last_block_hash === block_hash)) return;
  // if we have the same end blockhash already, dont write
  return await atomicWrite(
    `${
      pathPrefix ?? ""
    }getblocksbinbuffer/${Date.now()}-${start}-${end}-${block_hash}-getblocks.bin`,
    getBlocksBinResponseContent
  );
}
export type GetBlocksBinBufferItem = {
  start: number;
  end: number;
  filename: string;
  date: string;
  last_block_hash: string;
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

export type BlocksGenerator = AsyncGenerator<Uint8Array>;
export type SlaveViewPair = {
  viewpair: ViewPair;
  current_range: CacheRange;
  secret_spend_key?: string;
};

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
        nonHaltedWallets
          .slice(1)
          .map(
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
    if (bufferItem.end <= snail) {
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
    const [date, start, end, last_block_hash] = filename.split("-");
    ranges.push({
      start: parseInt(start),
      end: parseInt(end),
      filename,
      date,
      last_block_hash,
    });
  }
  return ranges;
}
export interface HasGetBlocksBinExecuteRequestMethod {
  getBlocksBinExecuteRequest: (
    params: GetBlocksBinRequest,
    stopSync?: AbortSignal
  ) => Promise<Uint8Array>;
}
