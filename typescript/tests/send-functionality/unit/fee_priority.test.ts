import { expect, mock, spyOn, test } from "bun:test";
import { NodeUrl, ScanCacheOpened, type Output } from "../../../dist/xmr3";
import type { MakeTransactionParams } from "../../../dist/send-functionality/transactionBuilding";

function feeOptionsFixture() {
  const feeEstimate = {
    status: "OK", fee: 2_000_000,
    fees: [2_000_000, 3_000_000, 4_000_000, 5_000_000], quantization_mask: 1,
  };
  const input: Output = {
    amount: 100_000_000_000n, block_height: 1, block_timestamp: 1,
    index_in_transaction: 0, index_on_blockchain: 7, payment_id: 0,
    stealth_address: "test", tx_hash: "test", is_miner_tx: false,
    primary_address: "test", subaddress_index: null, serialized: "test",
  };
  const create = spyOn(NodeUrl, "create").mockResolvedValue({
    getFeeEstimate: async () => feeEstimate,
    getOutputDistribution: async () => [8],
    sampleDecoys: () => ({ candidates: [7] }),
    getOutsBin: async () => Uint8Array.of(1),
    makeInput: () => "prepared-input",
  } as unknown as NodeUrl);
  const makePayment = mock((_params: MakeTransactionParams) => "payment-unsigned");
  const makeSweep = mock((_params: MakeTransactionParams) => "sweep-unsigned");
  const wallet = Object.assign(Object.create(ScanCacheOpened.prototype), {
    decoySampleCount: 20,
    decoyRetry: false,
    spendableInputs: () => [input],
    view_pair: {
      node_url: "test", makeTransaction: makePayment, makeSweepTransaction: makeSweep,
    },
  }) as ScanCacheOpened;
  const selectInputs = spyOn(wallet, "selectInputs");
  return {
    wallet, input, feeEstimate, makePayment, makeSweep, selectInputs,
    restore() {
      selectInputs.mockRestore();
      create.mockRestore();
    },
  };
}

test.each([
  ["unimportant", 2_000_000n],
  ["normal", 3_000_000n],
  ["elevated", 4_000_000n],
  ["priority", 5_000_000n],
] as const)("%s builds payments and sweeps with the default circuit breaker", async (fee_priority, rate) => {
  const fixture = feeOptionsFixture();
  const { wallet, input, feeEstimate, makePayment, makeSweep, selectInputs } = fixture;
  const payments = [{ address: "destination", amount: "1" }];
  try {
    await expect(wallet.makeTransaction({ payments, fee_priority })).resolves.toBe("payment-unsigned");
    await expect(wallet.sweepToExternalWallet("destination", [input], fee_priority)).resolves.toBe("sweep-unsigned");
    expect(selectInputs).toHaveBeenCalledWith(1n, rate);
    expect(makePayment).toHaveBeenCalledWith({
      inputs: ["prepared-input"], payments, fee_response: feeEstimate, fee_priority,
    });
    expect(makeSweep).toHaveBeenCalledWith({
      inputs: ["prepared-input"], payments: [{ address: "destination", amount: "0" }],
      fee_response: feeEstimate, fee_priority,
    });

    feeEstimate.fee = feeEstimate.fees[0] = 2_000_001;
    await expect(wallet.makeTransaction({ payments, fee_priority })).rejects.toThrow("fee too high");
    await expect(wallet.sweepToExternalWallet("destination", [input], fee_priority)).rejects.toThrow("fee too high");
    expect(makePayment).toHaveBeenCalledTimes(1);
    expect(makeSweep).toHaveBeenCalledTimes(1);
  } finally {
    fixture.restore();
  }
});

test("a breaker-only override builds payments and sweeps with unimportant priority", async () => {
  const fixture = feeOptionsFixture();
  const { wallet, input, feeEstimate, makePayment, makeSweep, selectInputs } = fixture;
  const payments = [{ address: "destination", amount: "1" }];
  const rate = 2_000_001;
  feeEstimate.fee = feeEstimate.fees[0] = rate;
  const fee_circuit_breaker = rate * 10_000;
  try {
    await expect(wallet.makeTransaction({ payments })).rejects.toThrow("fee too high");
    await expect(wallet.sweepToExternalWallet("destination", [input])).rejects.toThrow("fee too high");
    await expect(wallet.makeTransaction({ payments, fee_circuit_breaker })).resolves.toBe("payment-unsigned");
    await expect(wallet.sweepToExternalWallet("destination", [input], undefined, fee_circuit_breaker))
      .resolves.toBe("sweep-unsigned");
    expect(selectInputs).toHaveBeenCalledWith(1n, BigInt(rate));
    expect(makePayment).toHaveBeenCalledWith({
      inputs: ["prepared-input"], payments, fee_response: feeEstimate, fee_priority: "unimportant",
    });
    expect(makeSweep).toHaveBeenCalledWith({
      inputs: ["prepared-input"], payments: [{ address: "destination", amount: "0" }],
      fee_response: feeEstimate, fee_priority: "unimportant",
    });
    await expect(wallet.makeTransaction({ payments })).rejects.toThrow("fee too high");
    await expect(wallet.sweepToExternalWallet("destination", [input])).rejects.toThrow("fee too high");
    expect(makePayment).toHaveBeenCalledTimes(1);
    expect(makeSweep).toHaveBeenCalledTimes(1);
  } finally {
    fixture.restore();
  }
});

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

test("payment link execution forwards the payer's fee options", async () => {
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

  await tool.worker.execute_run!(ctx, "payment-link", { fee_priority: "elevated", fee_circuit_breaker: 30_000_000_000 });
  expect(sent).toEqual([expect.objectContaining({
    fee_priority: "elevated", fee_circuit_breaker: 30_000_000_000,
  })]);
});

test("payments and external sweeps keep the default fee limit and honor a custom limit", async () => {
  const rate = 2_000_001;
  const feeEstimate = { status: "OK", fee: rate, fees: [rate, rate], quantization_mask: 1 };
  const create = spyOn(NodeUrl, "create").mockResolvedValue({
    getFeeEstimate: async () => feeEstimate,
    getOutputDistribution: async () => [],
  } as unknown as NodeUrl);
  const wallet = Object.assign(Object.create(ScanCacheOpened.prototype), {
    view_pair: { node_url: "test", makeSweepTransaction: () => "unsigned" },
  }) as ScanCacheOpened;
  const payment = { payments: [{ address: "destination", amount: "1" }], inputs: [] };
  const limit = rate * 10000;

  try {
    await expect(wallet.calculateFeeAndSelectInputs(payment)).rejects.toThrow("fee too high");
    await expect(wallet.sweepToExternalWallet("destination", [])).rejects.toThrow("fee too high");
    await expect(wallet.sweepToExternalWallet("destination", [], "normal", limit)).resolves.toBe("unsigned");
    await expect(wallet.calculateFeeAndSelectInputs({ ...payment, fee_priority: "normal", fee_circuit_breaker: limit })).rejects.toThrow("not enough funds");
    await expect(wallet.sweepToExternalWallet("destination", [], undefined, 0)).rejects.toThrow("fee too high");
    await expect(wallet.sweepToExternalWallet("destination", [], undefined, -1)).rejects.toThrow("invalid fee circuit breaker");
    await expect(wallet.sweepToExternalWallet("destination", [])).rejects.toThrow("fee too high");
    feeEstimate.fees[0] = 2_000_000;
    await expect(wallet.sweepToExternalWallet("destination", [])).resolves.toBe("unsigned");
    await expect(wallet.calculateFeeAndSelectInputs(payment)).rejects.toThrow("not enough funds");
  } finally {
    create.mockRestore();
  }
});
