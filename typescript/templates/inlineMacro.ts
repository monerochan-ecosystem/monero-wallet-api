import * as fs from "fs";
export function fileToBase64(filepath: string): string {
  const source = fs.readFileSync(filepath);
  return source.toString("base64");
}

export function workerSourceToBase64(workerSourceCode: string): string {
  return Buffer.from(workerSourceCode, "utf8").toString("base64");
}

export function workerMainCodeToBase64(): string {
  const { stdout } = Bun.spawnSync([
    "bun",
    "run",
    "templates/workers/buildworker.ts",
  ]);
  return workerSourceToBase64(stdout.toString());
}
