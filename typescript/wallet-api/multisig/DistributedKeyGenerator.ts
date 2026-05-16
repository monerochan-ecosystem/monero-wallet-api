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

/**
 * derive a Monero address (mainnet, stagenet, testnet) from a DKG group key.
 * spend_public_key is the group_key hex from dkg_verify output.
 * view_secret_key is the 32-byte view secret key hex. (see performEscrowViewPairECDH on how to get one)
 *
 * @returns object with view_key, mainnet_primary, stagenet_primary, testnet_primary
 */
export async function getDkgMoneroAddress(
  spend_public_key: string,
  view_secret_key: string,
) {
  const dkg = await DistributedKeyGenerator.create();
  const result = dkg.getMoneroAddress({ spend_public_key, view_secret_key });
  if ("message" in result) {
    throw new Error(`getDkgMoneroAddress failed: ${result.message}`);
  }
  return result;
}

export type DkgGetPublicKeyResult = {
  dkg_public_key: string; // hex-encoded public key
};

export type DkgParticipateParams = {
  // DKG secret key as 64-byte hex string
  dkg_secret_key: string;
  // label string, will be hashed to 32-byte context
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
  // label string, will be hashed to 32-byte context
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
  i: number; // your participant index
  threshold_key: string; // hex-encoded serialized ThresholdKey
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

export type DkgGetMoneroAddressParams = {
  // group_key hex from dkg_verify output
  spend_public_key: string;
  // 32-byte view secret key hex
  view_secret_key: string;
};

export type DkgGetMoneroAddressResult = {
  view_key: string;
  mainnet_primary: string;
  stagenet_primary: string;
  testnet_primary: string;
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

  /**
   * derive a Monero address from a DKG group key.
   *
   * Input JSON keys expected by the rust wasm:
   *   spend_public_key (hex32) - the group_key hex from dkg_verify output
   *   view_secret_key (hex32) - 32-byte view secret key (see performEscrowViewPairECDH on how to get one)
   *
   * @param params - spendPublicKey and viewSecretKey as hex strings
   * @returns object with view_key, mainnet_primary, stagenet_primary, testnet_primary
   */
  public getMoneroAddress(
    params: DkgGetMoneroAddressParams,
  ): DkgGetMoneroAddressResult | DkgErrorResponse {
    const jsonStr = JSON.stringify(params);

    // set up write callback: rust calls input_string(json_len)
    this.writeToWasmMemory = (ptr, len) => {
      this.writeString(ptr, len, jsonStr);
    };

    // set up read callback: rust calls output_string()
    let result: DkgGetMoneroAddressResult | DkgErrorResponse | undefined;
    this.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };
    this.readErrorFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };

    //@ts-ignore
    this.tinywasi.instance.exports.dkg_get_monero_address(jsonStr.length);

    if (!result) {
      return { message: "No response from dkg_get_monero_address" };
    }
    return result;
  }
}
