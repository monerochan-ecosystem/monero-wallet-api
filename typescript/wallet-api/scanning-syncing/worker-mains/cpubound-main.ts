import { sleep, ViewPair, type ScanResult } from "../../api";
import { type ScanLoopInput, type ScanLoopYield } from "../scanresult/scanLoop";

/**
 * handle a single scan work item dispatched from the coordinator.
 * logs progress every 10 blocks, then sends the final result.
 */
let callcounter = 0;
export async function handleCpuboundScan(
  msg: ScanLoopInput,
  port?: MessagePort,
) {
  callcounter++;
  console.log("[cpubound] callcounter=" + callcounter);
  if (!msg) {
    console.log("[cpubound] no content msg! ( ScanLoopInput = undefined )");
    return;
  }
  if (msg === "cancel") {
    console.log("[cpubound] cancel msg! ( ScanLoopInput = cancel )");
    return;
  }
  console.log(
    "[cpubound] got scan msg, walletConfig=" +
      msg.walletConfig?.primary_address?.slice(0, 6),
  );
  const walletConfig = msg.walletConfig;
  const item = msg;
  if (!port) {
    console.log("[cpubound] no port!");
    return;
  }

  console.log(
    "[cpubound] primed, feeding workItem uuid=" +
      (item && typeof item === "object"
        ? item.work_uuid?.slice(0, 8)
        : "cancel"),
  );

  // feed work item, get first InProgress yield
  let blockCount = 0;
  const heighfrom =
    item.batch.get_blocks_result_meta.block_infos[item.from].block_height;
  const heightto =
    item.batch.get_blocks_result_meta.block_infos[item.to].block_height;
  const viewpair = await ViewPair.create(
    item.walletConfig.primary_address,
    item.walletConfig.secret_view_key,
    item.walletConfig.subaddress_index,
  );
  await viewpair.loadGetBlocksBinResponse(item.batch.data);

  const first_block_meta = item.batch.get_blocks_result_meta.block_infos[0];
  if (!first_block_meta) throw new Error("no first block meta");
  const scanResult: ScanResult = {
    outputs: [],
    all_key_images: [],
    new_height: first_block_meta.block_height + item.from,
    primary_address: walletConfig.primary_address,
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
    blockCount++;
    if (blockCount % 10 === 0) {
      console.log(
        "[cpubound] scanned " +
          blockCount +
          " " +
          walletConfig.primary_address.slice(0, 6),
        "@",
        heighfrom,
        "-",
        heightto,
      );
    }
    await sleep(10); // make sure the loop is not tight
  }
  // when blocks a small on regtest, we get a race withou this + the sleep in scheduleWorkOnCpuPorts
  // TODO: try and see if ready ping pong can replace this
  await sleep(700);
  sendFromCpuWorker(port, {
    type: "Ready",
    work_uuid: item.work_uuid,
    result: scanResult,
  });
}
export function handleCpuboundScanTry(msg: ScanLoopInput, port?: MessagePort) {
  try {
    handleCpuboundScan(msg, port);
  } catch (err) {
    console.error("[cpubound] error", err);
    throw err;
  }
}

export function sendFromCpuWorker(port: MessagePort, msg: ScanLoopYield) {
  port.postMessage(msg);
}
export function sendToCpuWorker(port: MessagePort, msg: ScanLoopInput) {
  port.postMessage(msg);
}
