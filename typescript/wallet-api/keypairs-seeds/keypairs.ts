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
