import { frost_dkg_wasm } from "../wasm-processing/wasmFile";
import { WasmProcessor } from "../wasm-processing/wasmProcessor";
/**
 * get the DKG public key from a 64-byte DKG secret key
 * @param dkgSecretKey - 64 byte Uint8Array dkg secret key
 * @returns - dkg public key as hex string
 */
export async function getDkgPublicKey(dkgSecretKey: Uint8Array) {
  const dkg = await DistributedKeyGenerator.create();
  const pubResult = dkg.getPublicKey(dkgSecretKey);
  if ("message" in pubResult) {
    throw new Error(`getPublicKey failed: ${pubResult.message}`);
  }
  return pubResult.dkg_public_key;
}

export type DkgGetPublicKeyResult = {
  dkg_public_key: string; // hex-encoded public key
};

export type DkgParticipateParams = {
  // DKG secret key as 64-byte hex string
  dkg_secret_key: string;
  // 32-byte context hex string
  context: string;
  // array of DKG public keys as hex strings
  dkg_public_keys: string[];
  // threshold number of signers
  t: number;
};

export type DkgParticipateResult = {
  // hex-encoded binary participation message
  participation: string;
};

export type DkgVerifyParams = {
  // DKG secret key as 64-byte hex string
  dkg_secret_key: string;
  // 32-byte context hex string
  context: string;
  // threshold number of signers
  t: number;
  // array of DKG public keys as hex strings
  dkg_public_keys: string[];
  // participant index -> hex participation message
  participations: Record<string, string>;
};

export type DkgVerifyValidResult = {
  group_key: string; // monero spend public key
  t: number;
  n: number;
};

export type DkgVerifyInvalidResult = {
  faulty_participants: number[];
};

export type DkgVerifyNotEnoughResult = {
  message: "NotEnoughParticipants";
};

export type DkgVerifyResult =
  | DkgVerifyValidResult
  | DkgVerifyInvalidResult
  | DkgVerifyNotEnoughResult;

export type DkgErrorResponse = {
  message: string;
};

export class DistributedKeyGenerator extends WasmProcessor {
  /**
   * create distributed key generator wasm instance,
   * without initializing generators
   * (in case you just want to get the public dkg key from a secret dkg key)
   *
   * @returns  - Promise<DistributedKeyGenerator>
   */
  public static async create(): Promise<DistributedKeyGenerator> {
    const dkg = new DistributedKeyGenerator();
    await dkg.initWasmModule(frost_dkg_wasm);
    return dkg;
  }
  /**
   * set up a distributed key generator with t threshold and n total participants
   * @param t  - total number of multisig participants
   * @param n  - threshold to sign a transaction
   * @returns  - Promise<DistributedKeyGenerator>
   */
  public static async createAndSetupGenerators(
    t: number,
    n: number,
  ): Promise<DistributedKeyGenerator> {
    const dkg = new DistributedKeyGenerator();
    await dkg.initWasmModule(frost_dkg_wasm);
    dkg.setupGenerators(t, n);
    return dkg;
  }

  /**
   * setupGenerators
   * configure the max threshold and max participants for the DKG generators.
   * if never called, defaults to 16, 16 used automatically on first DKG operation.
   */
  public setupGenerators(t: number, n: number) {
    //@ts-ignore
    this.tinywasi.instance.exports.setup_generators(t, n);
  }

  /**
   * derive the DKG public key from a 64-byte DKG secret key.
   *
   * @param dkgSecretKeyBytes 64-byte DKG secret key (from seed function)
   * @returns the DKG public key as a hex string, or an error object
   */
  public getPublicKey(
    dkgSecretKeyBytes: Uint8Array,
  ): DkgGetPublicKeyResult | DkgErrorResponse {
    // set up write callback: rust will call input(64) to read the secret key bytes
    this.writeToWasmMemory = (ptr, len) => {
      this.writeArray(ptr, len, dkgSecretKeyBytes);
    };

    // set up read callback: rust will call output_string() to return the result JSON
    let result: DkgGetPublicKeyResult | DkgErrorResponse | undefined;
    this.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };

    //@ts-ignore
    this.tinywasi.instance.exports.dkg_get_public_key();

    if (!result) {
      return { message: "No response from dkg_get_public_key" };
    }
    return result;
  }

  /**
   * participate in a DKG round.
   *
   * @param params dkg_secret_key as 64-byte hex string, context, dkg_public_keys array (length is n implicitly), t (threshold)
   * @returns The participation message as hex, or an error object
   */
  public participate(
    params: DkgParticipateParams,
  ): DkgParticipateResult | DkgErrorResponse {
    const jsonStr = JSON.stringify(params);

    // set up write callback: rust will call input_string(json_len) to read the JSON
    this.writeToWasmMemory = (ptr, len) => {
      this.writeString(ptr, len, jsonStr);
    };

    // set up read callback: rust will call output_string() to return the result JSON
    let result: DkgParticipateResult | DkgErrorResponse | undefined;
    this.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };
    this.readErrorFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };

    //@ts-ignore
    this.tinywasi.instance.exports.dkg_participate(jsonStr.length);

    if (!result) {
      return { message: "No response from dkg_participate" };
    }
    return result;
  }

  /**
   * verify DKG participations and extract the group key.
   *
   * @param params dkg_secret_key as 64-byte hex string, context, t (threshold), dkg_public_keys array (length is n implicitly),
   *  participations [ paricipant index -> hex participation message ]
   * @returns The group key and params, faulty participants, not-enough message, or error
   */
  public verify(params: DkgVerifyParams): DkgVerifyResult | DkgErrorResponse {
    const jsonStr = JSON.stringify(params);

    // set up write callback: rust will call input_string(json_len) to read the JSON
    this.writeToWasmMemory = (ptr, len) => {
      this.writeString(ptr, len, jsonStr);
    };

    // set up read callback: rust will call output_string() to return the result JSON
    let result: DkgVerifyResult | DkgErrorResponse | undefined;
    this.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };
    this.readErrorFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };

    //@ts-ignore
    this.tinywasi.instance.exports.dkg_verify(jsonStr.length);

    if (!result) {
      return { message: "No response from dkg_verify" };
    }
    return result;
  }
}
