import {
  scanLoop,
  type ScanLoopInput,
  type ScanLoopYield,
} from "../scanresult/scanLoop";
import type { WalletConfig } from "../scanresult/scanCoordination";

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

  try {
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
        sendFromCpuWorker(port, {
          type: "scan_result",
          result: result.value,
        });
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
      sendFromCpuWorker(port, {
        type: "scan_result",
        result: result.value,
      });
      console.log("[cpubound] sent scan_ready");
    }
    // now we end, but in practice we wait for a new message
  } catch (err: unknown) {
    console.log("[cpubound] error: " + String(err));
    try {
      sendFromCpuWorker(port, {
        type: "ERROR",
        payload: String(err),
      });
    } catch (_) {}
  }
}

export type CpuBoundError = {
  type: "ERROR";
  payload: string;
};
export type CpuWorkerResult = {
  type: "scan_result";
  result: ScanLoopYield;
};
export type CpuWorkerMessage = CpuBoundError | CpuWorkerResult;
export function sendFromCpuWorker(port: MessagePort, msg: CpuWorkerMessage) {
  port.postMessage(msg);
}
export function sendToCpuWorker(port: MessagePort, msg: ScanLoopInput) {
  port.postMessage(msg);
}
/**
 * dispatch a work item to a CPU worker via its MessagePort.
 * same return type as scanLoop, but wallet depdendent input
 * (scanloop sets wallet once in the setup phase)
 */
export async function* iterateCpuWorker(
  port: MessagePort,
): AsyncGenerator<ScanLoopYield, void, ScanLoopInput> {
  while (true) {
    const input = yield { type: "Ready" };
    if (input) {
      sendToCpuWorker(port, input);
    }
    const result = await awaitCpuWorkerResult(port);
    yield result;
  }
}

export function awaitMessageOnPort(port: MessagePort) {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      port.removeEventListener("message", handler);
      resolve(event.data);
    };
    port.addEventListener("message", handler);
  });
}

export async function awaitCpuWorkerResult(
  port: MessagePort,
): Promise<ScanLoopYield> {
  const result = await awaitMessageOnPort(port);
  if (
    result &&
    typeof result === "object" &&
    "type" in result &&
    "payload" in result &&
    result.type === "ERROR"
  ) {
    throw new Error(String(result.payload));
  } else if (
    result &&
    typeof result === "object" &&
    "type" in result &&
    "result" in result &&
    result.type === "scan_result"
  ) {
    return result.result as ScanLoopYield;
  }
  throw new Error("unreachable, awaitCpuWorkerResult promise rejected");
}
