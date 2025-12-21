import {
  getBlocksBinJson,
  type GetBlocksBinRequest,
  type Output,
  getOutsBinJson,
  type GetOutsBinRequest,
  getOutsBinExecuteRequest,
} from "./binaryEndpoints";
import {
  get_block_headers_range,
  get_fee_estimate,
  get_output_distribution,
  send_raw_transaction,
  type GetBlockHeadersRangeParams,
  type GetOutputDistributionParams,
  type SendRawTransactionResponse,
} from "./jsonEndpoints";

import {
  makeInput,
  sampleDecoys,
  type SignedTransaction,
  type Input,
} from "../send-functionality/transactionBuilding";
import { WasmProcessor } from "../wasm-processing/wasmProcessor";
/**
 * This class is useful to interact with Moneros DaemonRpc binary requests in a convenient way.
 * (similar to how you would interact with a REST api that gives you json back.)
 * The wasm part will handle the creation of the binary requests and parse the responses and return them as json.
 * {@link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin}
 */
export class NodeUrl extends WasmProcessor {
  protected constructor(public node_url: string) {
    super();
  }

  public static async create(node_url?: string): Promise<NodeUrl> {
    const nodeUrl = new NodeUrl(node_url || LOCAL_NODE_DEFAULT_URL);
    await nodeUrl.initWasmModule();
    return nodeUrl;
  }
  /**
   * This request helps making requests to the get_blocks.bin endpoint of the Monerod nodes.
   *  @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_blocksbin
   * @param params params that will be turned into epee (moner lib that does binary serialization)
   * @returns after the request is made it will return epee serialized objects that are then parsed into json.
   */
  public getBlocksBin(params: GetBlocksBinRequest) {
    return getBlocksBinJson(this, params);
  }
  /**
   * This request helps making requests to the get_outs.bin endpoint of the Monerod nodes.
   *  @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_outsbin
   * @param outputIndexArrayToFetch an array of numbers that represent the output indices to be fetched. (candidates array returned from sampleDecoys for example)
   * @returns after the request is made it will return epee serialized objects as a binary array.
   */
  public getOutsBin(outputIndexArrayToFetch: GetOutsBinRequest) {
    return getOutsBinExecuteRequest(this, outputIndexArrayToFetch);
  }
  /**
   * This request helps making requests to the get_outs.bin endpoint of the Monerod nodes.
   *  @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_outsbin
   * @param outputIndexArrayToFetch an array of numbers that represent the output indices to be fetched. (candidates array returned from sampleDecoys for example)
   * @returns after the request is made it will return epee serialized objects that are then parsed into json.
   */
  public getOutsBinJson(outputIndexArrayToFetch: GetOutsBinRequest) {
    return getOutsBinJson(this, outputIndexArrayToFetch);
  }
  /**
   * fetch output distribution from node (necessary to make input - also named OutputWithDecoys in Monero-oxide)
   * @param params defaults to: { amounts: [0], binary: false }
   * @returns returns output distribution necessary to sample input candidates
   */
  public async getOutputDistribution(
    params?: GetOutputDistributionParams
  ): Promise<number[]> {
    return (await get_output_distribution(this.node_url, params))
      .distributions[0].distribution;
  }
  /**
   * fetch fee estimate from node
   * @returns fee estimate response
   */
  public getFeeEstimate() {
    return get_fee_estimate(this.node_url);
  }
  /**
   * sample decoys with distibution (cumulative)
   * @param outputToBeSpentIndex the index of the output to be spent
   * @param distribution cumulative distribution fetched from the node with getOutputDistribution()
   * @param candidatesLength the amount of candidates to be sampled + 1 (the result will also contain the original index so in total the length of the resulting array will be this + 2)
   * @returns SampledDecoys: {candidates: number[]} - an array with output indices including the spent index
   */
  public sampleDecoys(
    outputToBeSpentIndex: number,
    distribution: number[],
    candidatesLength: number
  ) {
    return sampleDecoys(
      this,
      outputToBeSpentIndex,
      distribution,
      candidatesLength
    );
  }
  /**
   * makeInput helper that uses the wasm module to create an input for a transaction.
   * @param outputToBeSpent the output that should be spent
   * @param candidates array of output indices that can be used as decoys
   * @param get_outs_Response the response from a get_outs.bin request for the candidates
   * @returns the input serialized that can be used in transaction building
   */
  public makeInput(
    outputToBeSpent: Output,
    candidates: number[],
    get_outs_Response: Uint8Array
  ): Input {
    return makeInput(this, outputToBeSpent, candidates, get_outs_Response);
  }
  /**
   * Send a raw transaction to the node for broadcasting.
   * @link https://docs.getmonero.org/rpc-library/monerod-rpc/#send_raw_transaction
   * @param tx_as_hex tx_as_hex - string; Full transaction information as hexadecimal string.
   * @param do_not_relay (Optional) boolean; Stop relaying transaction to other nodes. Defaults to false.
   * @returns The response indicating success or failure, with validation details.
   */
  public async sendRawTransaction(
    tx_as_hex: SignedTransaction,
    do_not_relay: boolean = false
  ): Promise<SendRawTransactionResponse> {
    return send_raw_transaction(this.node_url, tx_as_hex, do_not_relay);
  }
  /**
   * Retrieve block headers for a specified range of heights.
   * @link https://docs.getmonero.org/rpc-library/monerod-rpc/#get_block_headers_range
   * @param params The parameters including start_height, end_height, and optional fill_pow_hash.
   * @returns The result object with headers, status, etc. Throws if the range is invalid:(end_height > daemonheight)
   */
  public async getBlockHeadersRange(params: GetBlockHeadersRangeParams) {
    return get_block_headers_range(this.node_url, params);
  }
}
export const LOCAL_NODE_DEFAULT_URL = "http://localhost:18081";
