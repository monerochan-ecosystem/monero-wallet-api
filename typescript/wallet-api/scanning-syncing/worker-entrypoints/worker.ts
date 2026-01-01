async function makeWorkerSource() {
  const workerMainCode = await Bun.build({
    entrypoints: ["./wallet-api/scanning-syncing/worker-mains/worker.ts"],
    target: "browser",
  });

  if (workerMainCode.success) {
    return await workerMainCode.outputs[0].text();
  }
}

export const workerMainCode = await makeWorkerSource();
