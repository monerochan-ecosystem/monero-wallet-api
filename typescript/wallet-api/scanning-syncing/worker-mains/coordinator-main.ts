import { coordinatorMain } from "../scanresult/scanCoordination";

export async function coordinatorMainWorker(
  scan_settings_path?: string,
  pathPrefix?: string,
  _cpuPorts?: MessagePort[],
) {
  console.log("coordinatorMainWorker, cpuPorts=" + _cpuPorts?.length);
  const gen = coordinatorMain(scan_settings_path, pathPrefix);
  for await (const event of gen) {
    console.log("event:", event);
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
}
