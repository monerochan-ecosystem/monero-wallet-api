import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";
import { type CacheChangedCallbackParameters } from "./scanresult/scanCache";
import { openScanSettingsFile } from "./scanSettings";
import { workerMainCode } from "./worker-entrypoints/worker";

const CPU_POOL_SIZE = 4;

export type WorkerSet = {
  fetchWorker: Worker;
  cpuWorkers: Worker[];
  terminate: () => void;
};

export async function createWebworker(
  handle_result?: (result: CacheChangedCallbackParameters) => void,
  scan_settings_path?: string,
  pathPrefix?: string,
  handle_error?: (error: unknown) => void,
): Promise<WorkerSet | undefined> {
  try {
    const scanSettings = await openScanSettingsFile(scan_settings_path);

    const node_url = scanSettings?.node_url || LOCAL_NODE_DEFAULT_URL;
    const cpu_worker_count =
      typeof scanSettings?.cpu_worker_count !== "undefined"
        ? scanSettings?.cpu_worker_count
        : CPU_POOL_SIZE;

    // spawn CPU workers
    const cpuWorkers: Worker[] = [];
    const cpuPorts: MessagePort[] = [];
    for (let i = 0; i < cpu_worker_count; i++) {
      const channel = new MessageChannel();
      const cpuWorker = await startWebworkerReady();
      cpuWorker.postMessage(
        { type: "setup", role: "cpubound", cpu_worker_id: i },
        [channel.port1],
      );
      cpuWorker.onerror = (e) => {
        if (handle_error)
          handle_error(
            "cpu worker " + i + " error: " + (e.message ?? String(e)),
          );
      };
      cpuWorkers.push(cpuWorker);
      cpuPorts.push(channel.port2);
    }

    const coordinationWorker = await startWebworkerReady();
    coordinationWorker.postMessage(
      {
        type: "setup",
        scan_settings_path,
        pathPrefix,
        role: "coordinator",
        node_url,
        start_height: 0,
      },
      cpuPorts,
    ); // transfer CPU port2s to coordination worker
    console.log(
      "[createWebworker] coordinator worker started, node_url=" + node_url,
      ", cpuPorts=" + cpuPorts.length,
    );

    coordinationWorker.onmessage = (event) => {
      if (event.data.type === "ERROR") {
        if (handle_error) handle_error(event.data.payload);
      } else if (event.data.type === "SCAN_RESULT") {
        if (handle_result) handle_result(event.data.payload);
      }
    };

    return {
      fetchWorker: coordinationWorker,
      cpuWorkers,
      terminate: () => {
        coordinationWorker.terminate();
        for (const w of cpuWorkers) w.terminate();
      },
    };
  } catch (error) {
    handle_error?.(error);
  }
}

export function makeWebworkerScript(): string {
  return workerMainCode;
}

export function startWebworker(
  handle_result?: (result: unknown) => void,
  handle_error?: (error: unknown) => void,
) {
  const blob = new Blob([workerMainCode], {
    type: "text/javascript",
  });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: "module" });
  worker.onmessage = (event) => {
    switch (event.data.type) {
      case "RESULT":
        if (handle_result) handle_result(event.data.payload);
        break;
      case "ERROR":
      case "scan_error":
        if (handle_error) handle_error(event.data.payload ?? event.data.error);
        break;
      case "DEBUG":
        console.log("worker debug:", event.data.payload);
        break;
    }
  };
  return worker;
}

// creates a worker via startWebworker, then waits for it to signal
// WORKER_READY (meaning self.onmessage = handleMessage has executed).
// after that, postMessage is safe, no race between worker startup
// and message delivery.
function startWebworkerReady(): Promise<Worker> {
  const worker = startWebworker();
  return new Promise<Worker>((resolve) => {
    const onReady = (e: MessageEvent) => {
      if (e.data?.type === "WORKER_READY") {
        worker.removeEventListener("message", onReady);
        resolve(worker);
      }
    };
    worker.addEventListener("message", onReady);
  });
}
