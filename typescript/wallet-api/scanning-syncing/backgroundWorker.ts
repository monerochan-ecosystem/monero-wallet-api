import { get_info, ViewPair } from "../api";
import { LOCAL_NODE_DEFAULT_URL } from "../node-interaction/nodeUrl";
import {
  type CacheChangedCallback,
  type CacheChangedCallbackParameters,
} from "./scanresult/scanCache";
import {
  openNonHaltedWallets,
  readNodeUrlFromScanSettings,
  walletSettingsPlusKeys,
} from "./scanSettings";
import { workerMainCode } from "./worker-entrypoints/worker";

const CPU_POOL_SIZE = 4;

export async function scanWallets(
  cacheChanged: CacheChangedCallback = (params) => console.log(params),
  stopSync?: AbortSignal,
  scan_settings_path?: string,
  pathPrefix?: string,
) {
  const nonHaltedWallets = await openNonHaltedWallets(scan_settings_path);
  const masterWalletSettings = nonHaltedWallets[0];
  if (!masterWalletSettings) return;
  const masterWithKeys = await walletSettingsPlusKeys(masterWalletSettings);
  const masterViewPair = await ViewPair.create(
    masterWalletSettings.primary_address,
    masterWithKeys.secret_view_key,
    masterWalletSettings.subaddress_index,
    masterWalletSettings.node_url,
  );
  await masterViewPair.scan(
    cacheChanged,
    stopSync,
    scan_settings_path,
    pathPrefix,
  );
}

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
    const node_url =
      (await readNodeUrlFromScanSettings(scan_settings_path)) ||
      LOCAL_NODE_DEFAULT_URL;

    // spawn CPU workers
    const cpuWorkers: Worker[] = [];
    const cpuPorts: MessagePort[] = [];
    for (let i = 0; i < CPU_POOL_SIZE; i++) {
      const channel = new MessageChannel();
      const cpuWorker = await startWebworkerReady();
      cpuWorker.postMessage({ type: "setup", role: "cpubound" }, [
        channel.port1,
      ]);
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
