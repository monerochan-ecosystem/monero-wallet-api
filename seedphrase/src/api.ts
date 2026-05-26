import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export function generateSeedphrase(): string {
  return bip39.generateMnemonic(wordlist);
}

export function validateSeedphrase(seedphrase: string): boolean {
  return bip39.validateMnemonic(seedphrase, wordlist);
}

// Irreversible: Uses KDF to derive 64 bytes of key data from mnemonic + optional password.
// returns 64 bytes of key data
export function deriveSecretKey(
  seedphrase: string,
  password?: string,
): Uint8Array {
  return bip39.mnemonicToSeedSync(seedphrase, password);
}
export async function deriveSecretKeyAsync(
  seedphrase: string,
  password?: string,
): Promise<Uint8Array> {
  return await bip39.mnemonicToSeed(seedphrase, password);
}
export async function deriveSecretKeyWebCrypto(
  seedphrase: string,
  password?: string,
): Promise<Uint8Array> {
  return await bip39.mnemonicToSeedWebcrypto(seedphrase, password);
}

export type WalletRoute = {
  identity: "main" | string;
  domain: "no_domain" | string;
  wallet_type: "single" | "sa_multi" | "pl_multi";
  wallet_slot: "0" | string;
};
export type GetSecretParams = {
  route: WalletRoute;
  seedphrase: string;
  password?: string;
  coin_name: "monero";
  key_type: "spend" | "comms" | "hotkey" | "hotkey-comms";
};
/**
 * Returns 64 bytes of key data, derived from mnemonic
 * @param params wallet_route, seedphrase, password, coin_name, key_type
 * @returns 64 bytes of key data - uses KDF ( bip39.mnemonicToSeedSync of noble bip39)
 */
export function getWalletSecret(params: GetSecretParams): Uint8Array {
  const { identity, domain, wallet_type, wallet_slot } = params.route;
  const seedphrase = params.seedphrase;
  const password = params.password ?? "no_password";
  const coin_name = params.coin_name;
  const key_type = params.key_type;
  if (!identity || !domain)
    throw new Error(
      `Invalid wallet route,
       identity and domain are required,
       default identity: "main",
       default domain: "no_domain"`,
    );
  if (
    wallet_type !== "single" &&
    wallet_type !== "sa_multi" &&
    wallet_type !== "pl_multi"
  )
    throw new Error("Unsupported wallet type");

  if (Number.isNaN(parseInt(wallet_slot)))
    throw new Error(
      "Invalid wallet id: " + wallet_slot + "has to be a number, default: 0",
    );
  if (coin_name !== "monero") throw new Error("Unsupported coin name");
  if (
    key_type !== "spend" &&
    key_type !== "comms" &&
    key_type !== "hotkey" &&
    key_type !== "hotkey-comms"
  )
    throw new Error("Unsupported key type");

  return deriveSecretKey(
    seedphrase,
    `${identity}/${domain}/${wallet_type}/${wallet_slot}/${password}-${coin_name}-${key_type}`,
  );
}

export const WALLET_DEFAULT_ROUTE: WalletRoute = {
  identity: "main",
  domain: "no_domain",
  wallet_type: "single",
  wallet_slot: "0",
};

export function walletRouteToString(route: WalletRoute): string {
  return `${route.identity}/${route.domain}/${route.wallet_type}/${route.wallet_slot}`;
}

export type WalletRouteResult =
  | { ok: true; route: WalletRoute }
  | { ok: false; error: string };

export function walletRouteFromString(input: string): WalletRouteResult {
  const parts = input.split("/");

  if (parts.length < 1 || !parts[0]) {
    return { ok: false, error: "missing identity" };
  }
  if (parts.length < 2 || !parts[1]) {
    return { ok: false, error: "missing domain" };
  }
  if (parts.length < 3 || !parts[2]) {
    return { ok: false, error: "missing wallet_type" };
  }
  if (parts.length < 4 || !parts[3]) {
    return { ok: false, error: "missing wallet_slot" };
  }
  if (parts.length > 4) {
    return {
      ok: false,
      error: "wallet route should only have 4 parts separated by /",
    };
  }

  const [identity, domain, wallet_type, wallet_slot] = parts;

  if (
    wallet_type !== "single" &&
    wallet_type !== "sa_multi" &&
    wallet_type !== "pl_multi"
  ) {
    return { ok: false, error: `invalid wallet_type: "${wallet_type}"` };
  }

  if (Number.isNaN(parseInt(wallet_slot))) {
    return { ok: false, error: `invalid wallet_slot: "${wallet_slot}"` };
  }
  if (parseInt(wallet_slot) < 0) {
    return { ok: false, error: `invalid wallet_slot: "${wallet_slot} < 0"` };
  }

  return {
    ok: true,
    route: { identity, domain, wallet_type, wallet_slot },
  };
}
