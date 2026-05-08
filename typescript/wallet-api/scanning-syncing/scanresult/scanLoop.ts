import type { ScanCache } from "./scanCache";
import {
  sleep,
  ViewPair,
  type GetBlocksBinBufferItem,
  type ScanResult,
  type WalletConfig,
  type WalletConfigPlusCache,
} from "../../api";

export type WorkItem = {
  walletConfig: WalletConfigPlusCache;
  batch: GetBlocksBinBufferItem;
  work_uuid: string;
  from: number;
  to: number;
  status:
    | "fresh"
    | "scanwork_in_progress"
    | "scanwork_done"
    | "process_result_done";
  result?: ScanResult;
};
export function makeWorkItem(
  walletConfig: WalletConfigPlusCache,
  batch: GetBlocksBinBufferItem,
  from?: number,
  to?: number,
): WorkItem {
  if (to && to > batch.get_blocks_result_meta.block_infos.length - 1) {
    // we could throw here but we dont. Off by one errors shouldnt break the application
    // and we put so much work into making processResult idempotent
    // so a caller bug scheduling too much work just leads to slightly worse performance
    //throw new Error("to is out of bounds");
    to = batch.get_blocks_result_meta.block_infos.length - 1;
  }
  if (typeof from === "number" && from < 0) {
    //throw new Error("from is out of bounds");
    from = 0;
  }
  return {
    walletConfig,
    batch: {
      ...batch,
      data: new Uint8Array(batch.data),
    },
    work_uuid: crypto.randomUUID(),
    from: from ?? 0, // default is to start from the batch beginning
    to: to ?? batch.get_blocks_result_meta.block_infos.length - 1, // default is to go to the batch end
    status: "fresh",
  };
}
export type ScanLoopIteratorResult = IteratorYieldResult<ScanLoopYield>;
export type ScanLoopInput = WorkItem | "cancel" | undefined;
export type ScanLoopYield = {
  type: "Ready" | "InProgress";
  work_uuid?: string;
  result?: ScanResult;
};
export async function* scanLoop(
  wallet: WalletConfig,
): AsyncGenerator<ScanLoopYield, void, ScanLoopInput> {
  let scanResult: ScanResult | undefined;
  let work_uuid: string | undefined;
  let workitem_batch_uuid: string | undefined;
  let loaded_batch_uuid: string | undefined;

  while (true) {
    const item: ScanLoopInput = yield {
      type: "Ready",
      work_uuid,
      result: scanResult,
    };
    if (item === "cancel" || item === undefined) continue;
    work_uuid = String(item.work_uuid);
    // 1.call loadGetBlocksBinResponse
    workitem_batch_uuid = String(item.batch.local_uuid);
    const viewpair = await ViewPair.create(
      item.walletConfig.primary_address,
      item.walletConfig.secret_view_key,
      item.walletConfig.subaddress_index,
    );
    await viewpair.loadGetBlocksBinResponse(item.batch.data);
    loaded_batch_uuid = workitem_batch_uuid;

    const first_block_meta = item.batch.get_blocks_result_meta.block_infos[0];
    if (!first_block_meta) throw new Error("no first block meta");
    scanResult = undefined;
    scanResult = {
      outputs: [],
      all_key_images: [],
      new_height: first_block_meta.block_height + item.from,
      primary_address: wallet.primary_address,
      block_infos: item.batch.get_blocks_result_meta.block_infos,
      daemon_height: item.batch.get_blocks_result_meta.daemon_height,
    };
    if (!(item.to >= item.from)) throw new Error("to must be >= from");
    for (let i = item.from; i <= item.to; i++) {
      // 2.call getBlocksBinScanOneBlock
      const blockResult = await viewpair.getBlocksBinScanOneBlock(i);
      if ("error" in blockResult) throw new Error(blockResult.error);
      //3. accumulate the scanresult

      scanResult.outputs.push(...blockResult.outputs);
      scanResult.all_key_images.push(...blockResult.all_key_images);
      scanResult.new_height = first_block_meta.block_height + i;

      //       //  update item.scanCache in memory will be done by the consumer
      // it is saved on the workitem, but the workitemBuffer is managed by the consumer
      // the consumer will reconcile the workitemBuffer on blocksbuffer changed yields from the fetchloop
      // it will also reconcile the blocksbuffer with the workitembuffer when work was done,
      // processScanResult will be called by the consumer and the scanresult will
      // be persisted to disk by the consumer.
      // if the workitem is at the left end of the workitemBuffer it will be shifted (popped from the left)
      // if it is removed like this from the workItemBuffer and eventually no items in the workItemBuffer
      // refercence the getBlocksBinBufferItem in the blocksbuffer, the blocksbufferitem is removed from the blocksbuffer
      // this is how the reconiliaton workitembuffer -> blocksbuffer happens.
      //
      // the reconciliation in blocksbuffer -> workitembuffer starts in the fetchloop before it sends a yield blocksbuffer changed
      // it is finished by the consumer of this generator after the yield blocksbuffer changed
      // this happens through checking all workitemBuffer items,
      //  if their GetBlocksBinBufferItem is in the blocksbuffer (via the local_uuid)
      // if they are not in the blocksbuffer they are removed from the workitemBuffer

      // then for all the blocksbuffer items that are not yet referenced by workbuffer items
      // they need to be silced into workitems and added to the workitembuffer

      //the reconciliation blocksbuffer -> workitembuffer is done on every blocks buffer changed event from the fetchloop
      // the reconciliation workitembuffer -> blocksbuffer is done on every workitembuffer marked done at the end of the workbuffer (left end)

      const input: ScanLoopInput = yield {
        type: "InProgress",
        work_uuid,
        result: scanResult,
      };
      if (input === "cancel") break;
      if (typeof input === "object")
        throw new Error(
          "cancel oldworkitem, before sending new workitem, while work in progress",
        );
      await sleep(10); // make sure the loop is not tight
    }

    // TODO: move scanCache forward with scanResult
    // this can not be done here, has to be done by the consumer of the generator
    // will be done by processScanResult in the consumer
  }
}

//theoretically markWorkItemAsDone could be done in the generator as WorkItem is passed in by reference
// but: eventually this has to be done accross CPU worker boundaries
// so we act on the yielded scan result
export async function markWorkItemAsDone(
  loop_event: ScanLoopYield,
  work_buffer: WorkItem[],
): Promise<WorkItem | undefined> {
  if (loop_event.type === "Ready" && loop_event.work_uuid) {
    const work_item = work_buffer.find(
      (w) => w.work_uuid === loop_event.work_uuid,
    );
    if (work_item) {
      work_item.result = loop_event.result;
      work_item.status = "scanwork_done";
      return work_item;
    }
  }
}
