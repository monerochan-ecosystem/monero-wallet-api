import * as fs from "fs";
import { workerMainCode } from "./workers/buildworker";
export function fileToBase64(filepath: string): string {
  const source = fs.readFileSync(filepath);
  return source.toString("base64");
}

export function workerSourceToBase64(workerSourceCode: string): string {
  return Buffer.from(workerSourceCode, "utf8").toString("base64");
}

export function workerMainCodeToBase64(): string {
  if (!workerMainCode)
    throw new Error("workerSourceCode compilation did not work");
  return workerSourceToBase64(workerMainCode);
}
