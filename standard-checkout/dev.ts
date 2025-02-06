import type { Subprocess } from "bun";
import { makeEntrypoint, standardDevReloader } from "@spirobel/mininext";

dev();
export default async function dev() {
  global.Reloader = standardDevReloader;
  Bun.serve(await makeEntrypoint());

  if (!global.buildProcess) {
    global.buildProcess = Bun.spawn({
      cmd: ["bun", "run", "build.ts", "dev"],
      stdio: ["inherit", "inherit", "inherit"],
    });
  }

  console.log("listening on: http://localhost:3000");
}
declare global {
  var buildProcess: null | Subprocess;
}
