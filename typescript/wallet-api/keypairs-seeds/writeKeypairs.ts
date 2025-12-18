// write testnet keys .env.local
// write stagenet keys .env
// write mainnet keys to stdout can > redirect to the place of your desires
// (but you really shouldnt, use a seedphrase instead)

export const stagenet_pk_path = ".env";
export const testnet_pk_path = ".env.local";

// will make new spend keys if no Bun.env["sk"] is present
// writes "vkPRIMARY_KEY=<view_key> \n skPRIMARY_KEY=<spend_key>" to .env for stagenet
export async function writeStagenetSpendViewKeysToDotEnv() {
  //TODO
}
// will make new spend keys if no Bun.env["sk"] is present
// writes "vkPRIMARY_KEY=<view_key> \n skPRIMARY_KEY=<spend_key>" to .env.local for testnet
export async function writeTestnetSpendViewKeysToDotEnvLocal() {
  // TODO
  //writeEnvLineToDotEnvRefresh();
}
// this should be used in a web backend that does (non custodial) scanning
// to add new view / spend keys, received from the users without a restart.
export async function writeEnvLineToDotEnvRefresh(
  key: string,
  value: string,
  path: string = ".env"
) {
  await writeEnvLineToDotEnv(key, value, path);
  Bun.env[key.trim()] = value.trim();
}

// assuming Bun.file + Bun.write are filled in or available natively,
// this is also used by io/indexedDB.ts
export async function writeEnvLineToDotEnv(
  key: string,
  value: string,
  path: string = ".env"
) {
  // this file should be treated as ephemeral
  // private spendkeys + viewkeys are deterministically derived from seedphrase and password
  // specific to indexedDB, browser extentension use case: Bun.env = .env contents
  //
  // we have to go through indexedDB just so the background worker has access to this.
  // (after waking up from an alarm or onmessage event)
  const file = Bun.file(path);
  const content = await file
    .text()
    .catch(() => {})
    .then((c) => c || "");
  const lines = content.split("\n");

  const idx = lines.findIndex((line) => line.startsWith(key));
  const updatedLines =
    idx === -1
      ? [...lines, `${key.trim()}=${value.trim()}`]
      : lines.with(idx, `${key.trim()}=${value.trim()}`);

  await Bun.write(".env", updatedLines.join("\n"));
}
