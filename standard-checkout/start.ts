import { makeEntrypoint } from "@spirobel/mininext";
import runOnStart from "./runOnStart";
await runOnStart();

Bun.serve(await makeEntrypoint());
