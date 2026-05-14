export function makeEscrowContext(context_index: number) {
  if (Number.isNaN(parseInt(String(context_index)))) {
    return { ok: false, error: `invalid context_index: "${context_index}"` };
  }
  if (parseInt(String(context_index)) < 0) {
    return {
      ok: false,
      error: `invalid context_index: "${context_index} < 0"`,
    };
  }
  if (parseInt(String(context_index)) > 10000) {
    return {
      ok: false,
      error: `invalid context_index: "${context_index} > 10000"`,
    };
  }
  const context = "escrow-" + String(context_index);
  return { ok: true, context, context_index };
}
export function parseEscrowContext(input: string) {
  const parts = input.split("-");
  if (parts.length < 1 || !parts[0] || parts[0] !== "escrow") {
    return {
      ok: false,
      error: "missing escrow string before - ${context_index}",
    };
  }
  const context_index = parts[1];
  if (Number.isNaN(parseInt(String(context_index)))) {
    return { ok: false, error: `invalid context_index: "${context_index}"` };
  }
  if (parseInt(String(context_index)) < 0) {
    return {
      ok: false,
      error: `invalid context_index: "${context_index} < 0"`,
    };
  }
  if (parseInt(String(context_index)) > 10000) {
    return {
      ok: false,
      error: `invalid context_index: "${context_index} > 10000"`,
    };
  }
  const context = "escrow-" + String(context_index);
  return { ok: true, context, context_index };
}
