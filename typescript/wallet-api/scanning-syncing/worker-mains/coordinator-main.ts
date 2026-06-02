import { coordinatorMainMultithreaded } from "../scanresult/scanCoordination";
import { log } from "../../io/logging";

export async function coordinatorMainWorker(
  scan_settings_path?: string,
  pathPrefix?: string,
  cpuPorts?: MessagePort[],
) {
  log("coordinatorMainWorker", "cpuPorts=" + cpuPorts?.length);
  try {
    const gen = coordinatorMainMultithreaded(
      scan_settings_path,
      pathPrefix,
      cpuPorts,
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
      }
    }
  } catch (error) {
    self.postMessage({ type: "ERROR", payload: error });
  }
}
