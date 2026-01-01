import * as fs from "fs";
export function fileToBase64(filepath: string): string {
  const source = fs.readFileSync(filepath);
  return source.toString("base64");
}
