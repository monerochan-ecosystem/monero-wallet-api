import { coordinatorMainMultithreaded } from "../scanresult/scanCoordination";
import { log } from "../../io/logging";

// one controller per coordinator worker; shutdown aborts fetch + race
let shutdownController: AbortController | undefined;

export function requestCoordinatorShutdown() {
  log("coordinatorMainWorker", ["shutdown requested"]);
  shutdownController?.abort();
}

export async function coordinatorMainWorker(
  scan_settings_path?: string,
  pathPrefix?: string,
  cpuPorts?: MessagePort[],
) {
  log("coordinatorMainWorker", "cpuPorts=" + cpuPorts?.length);
  shutdownController = new AbortController();
  try {
    const gen = coordinatorMainMultithreaded(
      scan_settings_path,
      pathPrefix,
      cpuPorts,
      shutdownController.signal,
    );
    for await (const event of gen) {
      log("coordinatorMainWorker", ["event:", event]);
      if (event.type === "scan_ready") {
        self.postMessage({
          type: "SCAN_RESULT",
          payload: {
            newCache: event.newCache,
            changed_outputs: event.changed_outputs,
          },
        });
      } else if (event.type === "shutdown_done") {
        self.postMessage({ type: "SHUTDOWN_DONE" });
        return;
      }
    }
    // generator returned without shutdown_done (e.g. empty)
    self.postMessage({ type: "SHUTDOWN_DONE" });
  } catch (error) {
    // still tell main thread we stopped so terminate can proceed
    self.postMessage({ type: "SHUTDOWN_DONE" });
    self.postMessage({ type: "ERROR", payload: error });
  }
}
