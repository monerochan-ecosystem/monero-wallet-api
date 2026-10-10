// loader for wasm bytes in packed and unpacked mode
// packed mode uses inlined bytes from wasmFile
// unpacked mode fetches bytes from files
// this keeps chrome store builds free from base64 blobs

let inlineMonero: Uint8Array<ArrayBuffer> | undefined;
let inlineDkg: Uint8Array<ArrayBuffer> | undefined;
let moneroUrl: string | undefined;
let dkgUrl: string | undefined;
let moneroCache: Uint8Array<ArrayBuffer> | undefined;
let dkgCache: Uint8Array<ArrayBuffer> | undefined;
let moneroFlight: Promise<Uint8Array<ArrayBuffer>> | undefined;
let dkgFlight: Promise<Uint8Array<ArrayBuffer>> | undefined;

export type WasmUrls = {
  monero?: string;
  dkg?: string;
};

// set inlined bytes, called once by packed entry
export function setInlineWasm(monero?: Uint8Array<ArrayBuffer>, dkg?: Uint8Array<ArrayBuffer>) {
  if (monero && monero.length) inlineMonero = monero;
  if (dkg && dkg.length) inlineDkg = dkg;
}

// set file urls, called by unpacked entry
export function setWasmUrls(urls: WasmUrls) {
  if (urls.monero) {
    moneroUrl = urls.monero;
    moneroCache = undefined;
  }
  if (urls.dkg) {
    dkgUrl = urls.dkg;
    dkgCache = undefined;
  }
}

// get current urls, used to pass urls to worker
export function getWasmUrls(): WasmUrls {
  return { monero: moneroUrl, dkg: dkgUrl };
}

// clear cache and urls, used in tests
// inline bytes stay set, packed tests need them
// unpacked tests set urls, urls win over inline so order does not matter
export function resetWasmLoaderForTests() {
  moneroUrl = undefined;
  dkgUrl = undefined;
  moneroCache = undefined;
  dkgCache = undefined;
  moneroFlight = undefined;
  dkgFlight = undefined;
}

async function fetchWasmBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  // bun can read local files directly
  try {
    // @ts-ignore bun only
    if (typeof Bun !== "undefined") {
      // @ts-ignore bun only
      const f = Bun.file(url);
      if (await f.exists()) return new Uint8Array(await f.arrayBuffer());
    }
  } catch {
    // fall through to fetch
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("wasm fetch failed: " + url + " " + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

// get monero wasm bytes, urls win over inline when set
// concurrent calls share one fetch via flight promise
export async function getMoneroWasmBytes(): Promise<Uint8Array<ArrayBuffer>> {
  if (moneroUrl) {
    if (moneroCache) return moneroCache;
    if (moneroFlight) return moneroFlight;
    moneroFlight = fetchWasmBytes(moneroUrl).then((b) => {
      moneroCache = b;
      moneroFlight = undefined;
      return b;
    }).catch((e) => {
      moneroFlight = undefined;
      throw e;
    });
    return moneroFlight;
  }
  if (inlineMonero && inlineMonero.length) return inlineMonero;
  throw new Error("monero wasm has no inline bytes and no url, call setWasmUrls first");
}

// get dkg wasm bytes, urls win over inline when set
// concurrent calls share one fetch via flight promise
export async function getDkgWasmBytes(): Promise<Uint8Array<ArrayBuffer>> {
  if (dkgUrl) {
    if (dkgCache) return dkgCache;
    if (dkgFlight) return dkgFlight;
    dkgFlight = fetchWasmBytes(dkgUrl).then((b) => {
      dkgCache = b;
      dkgFlight = undefined;
      return b;
    }).catch((e) => {
      dkgFlight = undefined;
      throw e;
    });
    return dkgFlight;
  }
  if (inlineDkg && inlineDkg.length) return inlineDkg;
  throw new Error("dkg wasm has no inline bytes and no url, call setWasmUrls first");
}
