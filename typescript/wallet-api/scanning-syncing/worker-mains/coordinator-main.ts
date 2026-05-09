import { coordinatorMainMultithreaded } from "../scanresult/scanCoordination";

export async function coordinatorMainWorker(
  scan_settings_path?: string,
  pathPrefix?: string,
  cpuPorts?: MessagePort[],
) {
  console.log("[coordinatorMainWorker] cpuPorts=" + cpuPorts?.length);
  try {
    const gen = coordinatorMainMultithreaded(
      scan_settings_path,
      pathPrefix,
      cpuPorts,
    );
    for await (const event of gen) {
      // console.log("event:", event);
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
    console.error("[coordinatorMainWorker] error:", error);
    self.postMessage({ type: "ERROR", payload: error });
  }
}
