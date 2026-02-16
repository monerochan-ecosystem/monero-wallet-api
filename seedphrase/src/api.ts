import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export function generateSeedphrase(): string {
  return bip39.generateMnemonic(wordlist);
}

export function validateSeedphrase(seedphrase: string): boolean {
  return bip39.validateMnemonic(seedphrase, wordlist);
}

// Irreversible: Uses KDF to derive 64 bytes of key data from mnemonic + optional password.
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
  identity: string;
  domain: string;
  wallet_type: "single" | "sa_multi" | "pl_multi";
  wallet_id: string;
};

export function getWalletSecret(
  { identity, domain, wallet_type, wallet_id }: WalletRoute,
  seedphrase: string,
  password: string = "",
): Uint8Array {
  if (!identity || !domain) throw new Error("Invalid wallet route");
  // default identity: "main", default domain: "no_domain"

  if (wallet_type !== "single" || "sa_multi" || "pl_multi")
    throw new Error("Unsupported wallet type");

  if (Number.isNaN(parseInt(wallet_id)))
    throw new Error("Invalid wallet id: " + wallet_id);

  return deriveSecretKey(
    seedphrase,
    `${identity}/${domain}/${wallet_type}/${wallet_id}/${password}`,
  );
}
