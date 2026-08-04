import { convertAmountBigIntThrows } from "../../send-functionality/conversion";
import { TOOL_MAGIC_STRING } from "../globals";

export type SendTransactionTool = {
  tool_id: "001";
  payload: SendTransactionToolPayload;
};
export type SendTransactionToolPayload = {
  address: string;
  amount: string;
  // when true, wallet skips counterparty validity GET and stays unverified
  no_check: boolean;
};
export function parseSendTransactionToolArgs(
  args: string[],
): SendTransactionTool | null {
  const amount = args[1];
  const address = args[3];
  // trailing _no_check splits into ["no", "check"] after underscore split
  const no_check =
    args.length >= 6 && args[args.length - 2] === "no" && args[args.length - 1] === "check";
  try {
    convertAmountBigIntThrows(amount);
  } catch (e) {
    return null;
  }
  if (address && amount) {
    return {
      tool_id: "001",
      payload: {
        address,
        amount,
        no_check,
      },
    };
  }
  return null;
}
export function createSendTransactionToolLink(
  address: string,
  amount: string,
  no_check: boolean = false,
): string {
  convertAmountBigIntThrows(amount);
  const base = `${TOOL_MAGIC_STRING}001_amount_${amount}_address_${address}`;
  return no_check ? `${base}_no_check` : base;
}
export function make001ToolLink(
  address: string,
  amount: string,
  no_check: boolean = false,
): string {
  return createSendTransactionToolLink(address, amount, no_check);
}

export const ADDRESS_VALID_RESPONSE = {
  valid_address: true,
} as const;

export const ADDRESS_INVALID_RESPONSE = {
  valid_address: false,
} as const;
