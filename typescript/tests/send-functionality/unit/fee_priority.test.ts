import { expect, spyOn, test } from "bun:test";
import { NodeUrl, ScanCacheOpened } from "../../../dist/xmr3";

test("external sweep passes an optional fee priority to the transaction builder", async () => {
  const feeEstimate = { status: "OK", fee: 1, fees: [1, 2, 3_000_000, 4_000_000], quantization_mask: 1 };
  const create = spyOn(NodeUrl, "create").mockResolvedValue({
    getFeeEstimate: async () => feeEstimate,
    getOutputDistribution: async () => [],
  } as unknown as NodeUrl);
  const priorities: (string | undefined)[] = [];
  const wallet = Object.assign(Object.create(ScanCacheOpened.prototype), {
    view_pair: {
      node_url: "test",
      makeSweepTransaction: (params: { fee_priority?: string }) => {
        priorities.push(params.fee_priority);
      },
    },
  }) as ScanCacheOpened;

  try {
    await wallet.sweepToExternalWallet("destination", [], "elevated");
    await wallet.sweepToExternalWallet("destination", []);
    expect(priorities).toEqual(["elevated", "unimportant"]);
  } finally {
    create.mockRestore();
  }
});

test("payment input selection uses the requested fee rate", async () => {
  const feeEstimate = { status: "OK", fee: 1, fees: [1, 2, 3_000_000, 4_000_000], quantization_mask: 1 };
  const create = spyOn(NodeUrl, "create").mockResolvedValue({
    getFeeEstimate: async () => feeEstimate,
  } as unknown as NodeUrl);
  const selectInputs = spyOn(ScanCacheOpened.prototype, "selectInputs").mockReturnValue([]);
  const wallet = Object.assign(Object.create(ScanCacheOpened.prototype), {
    view_pair: { node_url: "test" },
  }) as ScanCacheOpened;

  try {
    await expect(wallet.calculateFeeAndSelectInputs({
      payments: [{ address: "destination", amount: "1" }],
      fee_priority: "priority",
    })).rejects.toThrow("not enough funds");
    expect(selectInputs).toHaveBeenCalledWith(1n, 4_000_000n);
  } finally {
    selectInputs.mockRestore();
    create.mockRestore();
  }
});

test("payment link execution forwards the payer's fee priority", async () => {
  const { default: tool } = await import("../../../dist/tools/calls/001");
  const sent: unknown[] = [];
  const ctx = {
    getPort: () => undefined,
    log: {
      invocation: async () => ({
        address: "destination",
        amount: "1",
        wallet_to_send_from_pa: "wallet",
      }),
      append: async () => {},
    },
    getWallets: () => ({
      wallets: [{
        primary_address: "wallet",
        makeSignSendTransaction: async (params: unknown) => { sent.push(params); },
      }],
    }),
  } as unknown as Parameters<NonNullable<typeof tool.worker.execute_run>>[0];

  await tool.worker.execute_run!(ctx, "payment-link", { fee_priority: "elevated" });
  expect(sent).toEqual([expect.objectContaining({ fee_priority: "elevated" })]);
});
