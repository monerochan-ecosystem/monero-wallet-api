import {
  scanLoop,
  type ScanLoopInput,
  type ScanLoopYield,
} from "../scanresult/scanLoop";

/**
 * handle a single scan work item dispatched from the coordinator.
 * creates a scan loop, primes it, feeds the work item,
 * reports progress every 10 blocks, then sends the final result.
 * throws away the generator after each work item.
 * wrapped in a mutex in the worker main (see worker.ts)
 */
export async function handleCpuboundScan(
  msg: ScanLoopInput,
  port?: MessagePort,
) {
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
  const workItem = msg;
  if (!port) {
    console.log("[cpubound] no port!");
    return;
  }

    const gen = scanLoop(walletConfig);
    await gen.next(); // prime: create viewpair, hit initial yield
    console.log(
      "[cpubound] primed, feeding workItem uuid=" +
        (workItem && typeof workItem === "object"
          ? workItem.work_uuid?.slice(0, 8)
          : "cancel"),
    );

    // feed work item, get first InProgress yield
    let result = await gen.next(workItem);
    let blockCount = 0;

    while (!result.done && result.value.type === "InProgress") {
      blockCount++;
      if (blockCount % 10 === 0) {
      sendFromCpuWorker(port, result.value);
      }
      result = await gen.next();
    }

    console.log(
      "[cpubound] scan done, type=" +
        result.value?.type +
        ", work_uuid=" +
        result.value?.work_uuid?.slice(0, 8),
    );

    // result should be Ready with the completed scan
    if (!result.done && result.value.type === "Ready") {
    sendFromCpuWorker(port, result.value);
      console.log("[cpubound] sent scan_ready");
    }
    // now we end, but in practice we wait for a new message
}

export function sendFromCpuWorker(port: MessagePort, msg: ScanLoopYield) {
  port.postMessage(msg);
}
export function sendToCpuWorker(port: MessagePort, msg: ScanLoopInput) {
  port.postMessage(msg);
}

export type DelegatedScanLoop = AsyncGenerator<
  ScanLoopYield,
  void,
  ScanLoopInput
>;
/**
 * dispatch a work item to a CPU worker via its MessagePort.
 * same return type as scanLoop, but wallet depdendent input
 * (scanloop sets wallet once in the setup phase)
 */
export async function* delegatedScanLoop(port: MessagePort): DelegatedScanLoop {
  const messages: ScanLoopYield[] = [];
  let msg_promise_resolve: (
    value: ScanLoopYield | PromiseLike<ScanLoopYield>,
  ) => void;
  let msg_promise: Promise<ScanLoopYield> = new Promise((resolve) => {
    msg_promise_resolve = resolve;
  });
  const onmessage = (event: MessageEvent) => {
    messages.push(event.data);
    const msg = messages.shift();
    if (msg) {
      msg_promise_resolve(msg as ScanLoopYield);
    }
  };
  port.onmessage = onmessage;
  while (true) {
    const input = yield { type: "Ready" };
    if (input) {
      sendToCpuWorker(port, input);
    }
    const result = await msg_promise;
    msg_promise = new Promise((resolve) => {
      msg_promise_resolve = resolve;
    });
    yield result;
  }
}
