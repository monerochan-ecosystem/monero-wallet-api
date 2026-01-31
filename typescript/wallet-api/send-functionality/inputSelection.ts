import type { GetOutsResponseBuffer, NodeUrl, Output } from "../api";
import type { SampledDecoys } from "./transactionBuilding";

export type Payment = { address: string; amount: string };
export function sumPayments(payments: Payment[]): bigint {
  return payments.reduce((sum, payment) => sum + BigInt(payment.amount), 0n);
}

export type PreparedInput = {
  input: Output;
  sample: SampledDecoys;
  outsResponse: Promise<GetOutsResponseBuffer>;
};
export function prepareInput(
  node: NodeUrl,
  distibution: number[],
  input: Output,
  how_many_to_sample: number = 20,
): PreparedInput {
  const sample = node.sampleDecoys(
    input.index_on_blockchain,
    distibution,
    how_many_to_sample,
  );
  const outsResponse = node.getOutsBin(sample.candidates);
  return { input, sample, outsResponse };
}
