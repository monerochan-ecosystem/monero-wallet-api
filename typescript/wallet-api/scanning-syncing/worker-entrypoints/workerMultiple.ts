async function makeWorkerMultipleSource() {
  const workerMainCode = await Bun.build({
    entrypoints: [
      "./wallet-api/scanning-syncing/worker-mains/workerMultiple.ts",
    ],
    target: "bun",
  });

  if (workerMainCode.success) {
    return await workerMainCode.outputs[0].text();
  }
}

export const workerMultipleMainCode = await makeWorkerMultipleSource();
