import type { ScanSettingOpened } from "../../api";
import {
  TOOL_MAGIC_STRING,
  type ToolInvocationValidity,
} from "../globals";

export type CreateAndShareViewOnlyWalletTool = {
  tool_id: "002";
  payload: CreateAndShareViewOnlyWalletToolPayload;
};
export type CreateAndShareViewOnlyWalletToolPayload = {
  wallet_slot: number;
};
export function parseCreateAndShareViewOnlyWalletToolArgs(
  args: string[],
): CreateAndShareViewOnlyWalletTool | null {
  const wallet_slot = args[5];
  if (wallet_slot && !isNaN(parseInt(wallet_slot))) {
    return {
      tool_id: "002",
      payload: {
        wallet_slot: parseInt(wallet_slot),
      },
    };
  }
  return null;
}
export function createCreateAndShareViewOnlyWalletToolLink(
  wallet_slot?: number,
): string {
  wallet_slot = Number(wallet_slot) || 0;
  return `${TOOL_MAGIC_STRING}002_create_and_share_viewkey_slot_${wallet_slot}`;
}
export function make002ToolLink(wallet_slot?: number): string {
  return createCreateAndShareViewOnlyWalletToolLink(wallet_slot);
}

export type ShareViewkeyPayload = {
  viewkey: string;
  primary_address: string;
  tool_invo: {
    tool: { tool_id: string; payload: { wallet_slot: number } };
    found_in: "link" | "linkText";
    link: string;
    linkText: string;
    valid: ToolInvocationValidity;
  };
};
export type ShareViewkeyResult = {
  ok: boolean;
  successUrl: string | null;
};
export async function shareViewKey002(
  payload: ShareViewkeyPayload,
): Promise<ShareViewkeyResult> {
  const invo = payload.tool_invo;
  if (invo.tool.tool_id !== "002")
    return {
      ok: false,
      successUrl: null,
    };
  if (invo.valid !== "valid")
    return {
      ok: false,
      successUrl: null,
    };
  const link = invo[invo.found_in];
  const invo_link = new URL(link);
  const shareVKUrl = `${invo_link.origin}/monerochan002/`;
  const result = await fetch(shareVKUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      viewkey: payload.viewkey,
      primary_address: payload.primary_address,
      wallet_slot: invo.tool.payload.wallet_slot,
    }),
  });
  if (result.ok) {
    const data = (await result.json()) as {
      ok: boolean;
      successUrl?: string | null;
    };
    if (data && typeof data === "object" && "ok" in data && data.ok === true) {
      return {
        ok: true,
        successUrl: data.successUrl ?? null,
      };
    } else {
      return {
        ok: false,
        successUrl: null,
      };
    }
  } else {
    return {
      ok: false,
      successUrl: null,
    };
  }
}
export type ShareViewkey002Pruned = {
  viewkey: string;
  primary_address: string;
  wallet_slot: number;
};
// client wallet side
export async function potentialSuccessRedirect002(
  payload: ShareViewkeyPayload,
): Promise<ShareViewkeyResult | undefined> {
  const shareVKresult = await shareViewKey002(payload);
  if (shareVKresult.ok && shareVKresult.successUrl) {
    window.location.href = shareVKresult.successUrl;
    window.location.reload();
  } else {
    return shareVKresult;
  }
}

// backend response

export async function handle002ShareRequest(
  req: Request,
  wallets: ScanSettingOpened[],
  parsed_cb: (parsed_body: ShareViewkey002Pruned) => Promise<void>,
  successUrl?: string,
): Promise<ShareViewkeyResult> {
  try {
    const json_body = await req.json();
    const { viewkey, primary_address, wallet_slot } =
      json_body as ShareViewkey002Pruned;

    if (
      typeof viewkey !== "string" ||
      viewkey.trim().length === 0 ||
      typeof primary_address !== "string" ||
      primary_address.trim().length === 0 ||
      typeof wallet_slot !== "number"
    ) {
      return { ok: false, successUrl: null };
    }
    const foundSlot = wallets.find(
      (wallet) => wallet.wallet_slot === wallet_slot,
    );
    if (foundSlot) {
      if (foundSlot.primary_address !== primary_address) {
        return { ok: false, successUrl: null };
      }
    }
    await parsed_cb({ viewkey, primary_address, wallet_slot });
    return {
      ok: true,
      successUrl: successUrl ?? null,
    };
  } catch {
    return { ok: false, successUrl: null };
  }
}
export default {
  content: {
    parse: parseCreateAndShareViewOnlyWalletToolArgs,
  },
};
