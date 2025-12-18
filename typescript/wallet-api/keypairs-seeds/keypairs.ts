/**
 * "So when we first decided to create a mnemonic system the spec we
 * came up with was: take the seed from the mnemonic, hash it for the
 * spend key, hash it twice for the view key. Somewhere during the
 * simplewallet implementation we forgot about that, and just used the
 * mnemonic seed as the spendkey directly.
 *
 * This proved to be a blessing in disguise, though, as we'd not realised
 * that people might want to retrieve their seed. Using our original
 * design this wouldn't have been possible, as we didn't store the seed
 * in the wallet file.
 *
 * Much later on when we were creating MyMonero (a different group of
 * developers, I'm the only common link between the two) we decided that
 * a 13 word seed would be much easier for people to remember, but
 * because we wanted it to match simplewallet's implementation we made
 * sure that we followed the spec... as it was originally... before we
 * duffed the implementation."
 */
// Source: https://old.reddit.com/r/Monero/comments/3s80l2/why_mymonero_key_derivation_is_different_than_for/cwv5lzs/

// rpc create new wallet command handling code calls generate() method on wallet2 object instance
// 3653:       wal->generate(wallet_file, req.password, dummy_key, false, false);
//https://github.com/monero-project/monero/blob/48ad374b0d6d6e045128729534dc2508e6999afe/src/wallet/wallet_rpc_server.cpp#L3653

// wallet2.cpp generate method definition last few lines, notice it returns retval which is the result of m_account.generate():
/**
 *  crypto::secret_key retval = m_account.generate(recovery_param, recover, two_random);

  [ ... ommitted irrelevant wallet key file saving lines... ]
  return retval;
}
 */
// https://github.com/monero-project/monero/blob/48ad374b0d6d6e045128729534dc2508e6999afe/src/wallet/wallet2.cpp#L5683

// the account.generate() method is defined in account.cpp.
// Relevant lines show it calls the crypto.cpp generate_keys() method twice.
// 1. the first call uses a random number generator to make the spend private key
//    (and calls sc_reduce32 on it to make sure it is a valid ed25519 scalar)
// 2. then it hashes that spend private key with keccak to make the view private key
// 3. then it calls generate_keys() again on this hashed value to make the view private key
//   (to make sure via sc_reduce32 that the view private key is a valid ed25519 scalar)
//
// another side effect of this generate_keys function is that it creates the respective public keys from the private keys
/**
 *   crypto::secret_key first = generate_keys(m_keys.m_account_address.m_spend_public_key, m_keys.m_spend_secret_key, recovery_key, recover);

    // rng for generating second set of keys is hash of first rng.  means only one set of electrum-style words needed for recovery
    crypto::secret_key second;
    keccak((uint8_t *)&m_keys.m_spend_secret_key, sizeof(crypto::secret_key), (uint8_t *)&second, sizeof(crypto::secret_key));

    generate_keys(m_keys.m_account_address.m_view_public_key, m_keys.m_view_secret_key, second, two_random ? false : true);
    [ ... ommitted irrelevant timestamp lines... ]
     return first; [... returns first which is the spend private key ... ]
 */
// https://github.com/monero-project/monero/blob/48ad374b0d6d6e045128729534dc2508e6999afe/src/cryptonote_basic/account.cpp#L166-L195

// generate_keys() method definition shows it calls sc_reduce32 on the input key material to make sure it is a valid ed25519 scalar
// https://github.com/monero-project/monero/blob/master/src/crypto/crypto.cpp#L153

// side note: simplewallet cpp codepath is similar to the walletrpc server codepath shown above
// cryptonote_basic/account.cpp  generate() method returns first (also known as the spend private key) which becomes recovery_val:
// 4832 recovery_val = m_wallet->generate(m_wallet_file, std::move(rc.second).password(), recovery_key, recover, two_random, create_address_file);
// https://github.com/monero-project/monero/blob/48ad374b0d6d6e045128729534dc2508e6999afe/src/simplewallet/simplewallet.cpp#L4832

// simple wallet turns spend private key (recovery_val) into mnemonic words with this call:
// 4849   crypto::ElectrumWords::bytes_to_words(recovery_val, electrum_words, mnemonic_language);
// https://github.com/monero-project/monero/blob/48ad374b0d6d6e045128729534dc2508e6999afe/src/simplewallet/simplewallet.cpp#L4849

import { WasmProcessor } from "../wasm-processing/wasmProcessor";
export type SpendKey = string;
export async function makeSpendKey(): Promise<SpendKey> {
  const wasmProcessor = await WasmProcessor.init();

  let result: SpendKey | undefined = undefined;
  wasmProcessor.readFromWasmMemory = (ptr, len) => {
    result = String(wasmProcessor.readString(ptr, len));
  };
  //@ts-ignore
  wasmProcessor.tinywasi.instance.exports.make_spendkey();
  if (!result) {
    throw new Error("Failed to make spend key");
  }
  return result as SpendKey;
}
export type ViewPairJson = {
  view_key: string;
  mainnet_primary: string;
  stagenet_primary: string;
  testnet_primary: string;
};

export async function makeViewKey(
  spend_private_key: string
): Promise<ViewPairJson> {
  const wasmProcessor = await WasmProcessor.init();
  wasmProcessor.writeToWasmMemory = (ptr, len) => {
    wasmProcessor.writeString(ptr, len, spend_private_key);
  };
  let result: ViewPairJson | undefined = undefined;
  wasmProcessor.readFromWasmMemory = (ptr, len) => {
    result = JSON.parse(wasmProcessor.readString(ptr, len));
  };
  //@ts-ignore
  wasmProcessor.tinywasi.instance.exports.make_viewkey(
    spend_private_key.length
  );
  if (!result) {
    throw new Error("Failed to obtain view key from spend key.");
  }
  return result as ViewPairJson;
}
/**
 *
 * unlike crypto-ops.c sc_reduce32, this is not unrolled
 * we run this once at wallet creation, no timing side channel expected,
 * goal is to be as clear as possible.
 *
 * crypto-ops.c source: https://github.com/monero-project/monero/blob/master/src/crypto/crypto-ops.c#L2432-L2544
 * @param input - random 32 bytes used as seed, private key
 * @returns - reduced 32 bytes that are a valid ed25519 scalar
 */
function sc_reduce32(input: Uint8Array): Uint8Array {
  if (input.length !== 32) throw new Error("Input must be 32 bytes");
  const x = bytesToBigInt(input);
  const l = 2n ** 252n + 27742317777372353535851937790883648493n;
  const reduced = x % l;
  return bigIntToBytes(reduced);
}
// l source: https://datatracker.ietf.org/doc/html/rfc8032#section-5.1

/**
 * This function turns a list of bytes into one big number.
 * It uses a loop to add up each byte after moving it to the right spot.
 * Each byte is like a digit in a number where positions grow by 256 each time.
 * Shifting left by 8 bits per position multiplies by 256 to place it correctly.
 * This builds the full number step by step without mistakes.
 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.reduce(
    (acc, byte, i) => acc + (BigInt(byte) << BigInt(i * 8)),
    0n
  );
}
/**
 * The function starts with 0 as the total.
 * It takes the first byte and adds it as is.
 * For the next byte, it moves it left by 8 bits before adding.
 * This move makes room for the previous byte below it.
 * Each further byte shifts more to stack on top.
 */

// Other direction:

/**
 * This function breaks a big number into a list of small bytes.
 * It creates a list of fixed size and fills each spot with one byte from the number.
 * Shifting right brings the right part down to grab it.
 * Masking keeps only that one byte and ignores the rest.
 * It does this for each position to get the full list.
 */
function bigIntToBytes(value: bigint, length: number = 32): Uint8Array {
  return Uint8Array.from({ length }, (_, i) =>
    Number((value >> BigInt(i * 8)) & 0xffn)
  );
}
/**
 * The function makes an empty list of the given length.
 * For the first spot, it takes the lowest byte.
 * It shifts the number right by 0 bits at start.
 * Masking with 255 grabs just 8 bits.
 * For the next spot, it shifts right by 8 bits first.
 */
function testBigIntUint8Conversion(
  originalBigInt: bigint,
  length: number = 32
): boolean {
  const bytes = bigIntToBytes(originalBigInt, length);
  const reconstructedBigInt = bytesToBigInt(bytes);
  console.log("Original BigInt:", originalBigInt);
  console.log("Bytes:", bytes);
  console.log("Reconstructed BigInt:", reconstructedBigInt);
  return originalBigInt === reconstructedBigInt;
}

// usage
// const testValue = 123456789012345678901234567890n; // A BigInt fitting < 32 bytes
// console.log("Test result:", testBigIntUint8Conversion(testValue)); // Should log true

function testScReduce32(): boolean {
  const secret_key = new Uint8Array(32);
  crypto.getRandomValues(secret_key);
  const reduced = sc_reduce32(secret_key);
  const reducedBigInt = bytesToBigInt(reduced);
  const l = 2n ** 252n + 27742317777372353535851937790883648493n;
  const isValid =
    reducedBigInt >= 0n && reducedBigInt < l && reduced.length === 32;
  console.log("Random input:", secret_key);
  console.log("Reduced output:", reduced);
  console.log("Reduced as BigInt:", reducedBigInt);
  console.log("Is valid Ed25519 scalar:", isValid);

  // non random example (do not use not cryptographically secure values in production. use crypto.getRandomValues for real keys)
  const deadbeef = new Uint8Array(32).fill(0xde);
  const reducedDeadbeef = sc_reduce32(deadbeef);
  const reducedDeadbeefBigInt = bytesToBigInt(reducedDeadbeef);
  const isValidDeadbeef =
    reducedDeadbeefBigInt >= 0n &&
    reducedDeadbeefBigInt < l &&
    reducedDeadbeef.length === 32;
  console.log("Deadbeef input:", deadbeef);
  console.log("Reduced deadbeef output:", reducedDeadbeef);
  console.log("Reduced deadbeef as BigInt:", reducedDeadbeefBigInt);
  console.log("Is valid Ed25519 scalar (deadbeef):", isValidDeadbeef);

  return isValid && isValidDeadbeef;
}

// usage
// console.log("Test result:", testScReduce32()); // Should log true
