import { type ScanResultCallback } from "../scanning-syncing/scanResult";
import { ViewPair } from "./ViewPair";
import { type GetBlocksResultMeta } from "../node-interaction/binaryEndpoints";

/**
 * The ViewPairs class contains a set of ViewPair objects that can be used to scan multiple addresses at once.
 * (while only retrieving the blocks from the node once)
 */
export class ViewPairs {
  private viewPairs: Map<string, ViewPair>;

  protected constructor() {
    this.viewPairs = new Map<string, ViewPair>();
  }
  public static async create(
    pairs: AddressAndViewKey[],
    node_url?: string
  ): Promise<ViewPairs> {
    const viewPairs = new ViewPairs();
    for (const element of pairs) {
      const viewPair = await ViewPair.create(
        element.primary_address,
        element.secret_view_key,
        node_url
      );
      viewPairs.viewPairs.set(element.primary_address, viewPair);
    }
    return viewPairs;
  }

  public async addViewPair(
    primary_address: string,
    secret_view_key: string,
    node_url?: string
  ): Promise<ViewPair> {
    const viewPair = await ViewPair.create(
      primary_address,
      secret_view_key,
      node_url
    );
    this.viewPairs.set(primary_address, viewPair);
    return viewPair;
  }

  public getViewPair(primary_address: string): ViewPair | undefined {
    return this.viewPairs.get(primary_address);
  }
  /**
   * This method will use getBlocks.bin from start height to daemon height.
   * This is CPU bound work, so it should be executed in a seperate thread (worker).
   * The scanner.ts worker in the standard-checkout dir shows how to keep scanning after the tip is reached.
   * It also shows how the outputs are saved (note the unqiue requirement for the stealth_adress).
   * @param start_height the height to start syncing from.
   * @param callback this function will get the new outputs as they are found as a parameter
   * @param stopSync optional AbortSignal to stop the syncing process
   * @param stop_height optional height to stop scanning at. (final new_height will be >= stop_height)
   */
  public async scan(
    start_height: number,
    callback: ScanResultCallback,
    stopSync?: AbortSignal,
    stop_height: number | null = null
  ) {
    let latest_meta: GetBlocksResultMeta = {
      new_height: start_height,
      daemon_height: start_height + 1,
      status: "",
      primary_address: "",
    };
    while (latest_meta.new_height < latest_meta.daemon_height) {
      let firstResponse: Uint8Array | undefined;
      for (const [key, value] of this.viewPairs) {
        if (!firstResponse) {
          firstResponse = await value.getBlocksBinExecuteRequest(
            {
              start_height: latest_meta.new_height - 1,
            },
            stopSync
          );
        }
        const res = await value.getBlocksBinScanResponse(
          firstResponse,
          (meta) => {
            latest_meta = meta;
          }
        );
        if (res === undefined) {
          await callback({});
        } else {
          await callback(res);
        }
        if (stop_height !== null && latest_meta.new_height >= stop_height)
          return;
      }
    }
  }
}
export type AddressAndViewKey = {
  primary_address: string;
  secret_view_key: string;
};
