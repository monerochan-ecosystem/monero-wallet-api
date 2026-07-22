/**
 * unit tests for graceful coordinator shutdown helpers.
 * no monerod, no wasm, no workers.
 */
import { test, expect, beforeEach } from "bun:test";
import { rm } from "node:fs/promises";
import { sleep } from "../../../wallet-api/io/sleep";
import { handleCpuboundScan } from "../../../wallet-api/scanning-syncing/worker-mains/cpubound-main";
import {
  resetInProgressWorkItems,
  type PortStatus,
  cancelBusyCpuPorts,
} from "../../../wallet-api/scanning-syncing/scanresult/scanCoordination";
import type { WorkItem } from "../../../wallet-api/scanning-syncing/scanresult/scanLoop";

const DIR = "test-data/graceful-shutdown";

beforeEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

test("sleep rejects when signal aborts", async () => {
  const ac = new AbortController();
  const p = sleep(5000, ac.signal);
  ac.abort();
  await expect(p).rejects.toBeTruthy();
});

test("sleep rejects immediately if signal already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  await expect(sleep(1000, ac.signal)).rejects.toBeTruthy();
});

test("sleep without signal still resolves", async () => {
  await sleep(5);
  expect(true).toBe(true);
});

test("handleCpuboundScan cancel returns Canceled", async () => {
  const result = await handleCpuboundScan("cancel", { cancel: false });
  expect(result).toEqual({ type: "Canceled" });
});

test("resetInProgressWorkItems flips in-progress to fresh", () => {
  const workBuffer = [
    {
      work_uuid: "a",
      status: "scanwork_in_progress",
      result: { outputs: [] },
    },
    {
      work_uuid: "b",
      status: "scanwork_done",
      result: { outputs: [] },
    },
    {
      work_uuid: "c",
      status: "fresh",
    },
  ] as unknown as WorkItem[];

  resetInProgressWorkItems(workBuffer);

  expect(workBuffer[0].status).toBe("fresh");
  expect(workBuffer[0].result).toBeUndefined();
  expect(workBuffer[1].status).toBe("scanwork_done");
  expect(workBuffer[1].result).toBeDefined();
  expect(workBuffer[2].status).toBe("fresh");
});

test("cancelBusyCpuPorts sends cancel and frees ports", async () => {
  const sent: unknown[] = [];
  let resolveBusy: (v: { type: "Canceled" }) => void = () => {};
  const busyPromise = new Promise<{ type: "Canceled" }>((resolve) => {
    resolveBusy = resolve;
  });

  const ports: PortStatus[] = [
    {
      port: {
        postMessage: (msg: unknown) => {
          sent.push(msg);
          if (msg === "cancel") resolveBusy({ type: "Canceled" });
        },
      } as unknown as MessagePort,
      promise: busyPromise,
    },
    {
      port: {
        postMessage: (msg: unknown) => sent.push(msg),
      } as unknown as MessagePort,
      promise: null,
    },
  ];

  await cancelBusyCpuPorts(ports, 1000);

  expect(sent).toEqual(["cancel"]);
  expect(ports[0].promise).toBeNull();
  expect(ports[1].promise).toBeNull();
});
