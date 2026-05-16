import { frost_dkg_wasm } from "../wasm-processing/wasmFile";
import { WasmProcessor } from "../wasm-processing/wasmProcessor";

// Input: {"threshold_key":"hex","unsigned_tx":"hex"}
// Output: {"preprocess":"hex"}
export type MoneroPreprocessParams = {
  threshold_key: string;
  unsigned_tx: string;
};

export type MoneroPreprocessResult = {
  preprocess: string;
};

// Input: {"preprocesses":{"1":"hex","2":"hex",...}}
// Output: {"share":"hex"}
export type MoneroSignParams = {
  preprocesses: Record<string, string>;
};

export type MoneroSignResult = {
  share: string;
};

// Input: {"shares":{"1":"hex","2":"hex",...}}
// Output: {"signed_tx":"hex"}
export type MoneroCompleteParams = {
  shares: Record<string, string>;
};

export type MoneroCompleteResult = {
  signed_tx: string;
};

export type MoneroErrorResponse = {
  message: string;
};

export class MultiSigTxSigner extends WasmProcessor {
  public static async create(): Promise<MultiSigTxSigner> {
    const signer = new MultiSigTxSigner();
    await signer.initWasmModule(frost_dkg_wasm);
    return signer;
  }

  /**
   * preprocess
   *
   * @param params threshold_key hex, unsigned_tx hex
   * @returns preprocess hex
   */
  public preprocess(
    params: MoneroPreprocessParams,
  ): MoneroPreprocessResult | MoneroErrorResponse {
    const jsonStr = JSON.stringify(params);

    this.writeToWasmMemory = (ptr, len) => {
      this.writeString(ptr, len, jsonStr);
    };

    let result: MoneroPreprocessResult | MoneroErrorResponse | undefined;
    this.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };
    this.readErrorFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };

    //@ts-ignore
    this.tinywasi.instance.exports.monero_preprocess(jsonStr.length);

    if (!result) {
      return { message: "No response from monero_preprocess" };
    }
    return result;
  }

  /**
   * sign
   *
   * @param params preprocesses map from all signers
   * @returns share hex
   */
  public sign(
    params: MoneroSignParams,
  ): MoneroSignResult | MoneroErrorResponse {
    const jsonStr = JSON.stringify(params);

    this.writeToWasmMemory = (ptr, len) => {
      this.writeString(ptr, len, jsonStr);
    };

    let result: MoneroSignResult | MoneroErrorResponse | undefined;
    this.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };
    this.readErrorFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };

    //@ts-ignore
    this.tinywasi.instance.exports.monero_sign(jsonStr.length);

    if (!result) {
      return { message: "No response from monero_sign" };
    }
    return result;
  }

  /**
   * complete
   *
   * @param params shares map from all signers
   * @returns signed_tx hex
   */
  public complete(
    params: MoneroCompleteParams,
  ): MoneroCompleteResult | MoneroErrorResponse {
    const jsonStr = JSON.stringify(params);

    this.writeToWasmMemory = (ptr, len) => {
      this.writeString(ptr, len, jsonStr);
    };

    let result: MoneroCompleteResult | MoneroErrorResponse | undefined;
    this.readFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };
    this.readErrorFromWasmMemory = (ptr, len) => {
      result = JSON.parse(this.readString(ptr, len));
    };

    //@ts-ignore
    this.tinywasi.instance.exports.monero_complete(jsonStr.length);

    if (!result) {
      return { message: "No response from monero_complete" };
    }
    return result;
  }
}
