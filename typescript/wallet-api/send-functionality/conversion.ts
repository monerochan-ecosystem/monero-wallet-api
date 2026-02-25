export function truncateDecimalString(str: string, decimals = 3): string {
  if (!str.includes(".")) return str;

  const [integer, fraction = ""] = str.split(".");
  const truncatedFraction = fraction.slice(0, decimals);
  return truncatedFraction ? `${integer}.${truncatedFraction}` : integer!;
}

export function convertBigIntAmount(amount: bigint): string {
  if (amount < 0) amount *= -1n;
  let display_amount = "";
  // to go from atomic units to display amount,
  // we move from the end to the beginning and insert a dot 12 digits in
  // https://www.getmonero.org/resources/moneropedia/atomic-units.html
  let afterDot = amount.toString().padStart(12, "0").slice(-12);
  let beforeDot = amount.toString().padStart(12, "0").slice(0, -12);
  if (!beforeDot || beforeDot.startsWith("0")) beforeDot = "0";
  display_amount = beforeDot + ".";
  display_amount += afterDot;
  // remove trailing zeros
  while (display_amount[display_amount.length - 1] === "0") {
    display_amount = display_amount.slice(0, -1);
  }
  const last_char = display_amount.at(-1);
  if (last_char === ".") display_amount = display_amount.slice(0, -1);
  // trailing . or , should be removed
  return display_amount;
}
export function convertAmountBigInt(amount_double: string): bigint {
  // accept both dot and comma
  amount_double = amount_double.replaceAll(",", ".");
  const last_char = amount_double.at(-1);
  if (last_char === ".") amount_double = amount_double.slice(0, -1);
  // trailing . or , should be removed
  const beforeDot = amount_double.split(".")[0];
  let afterDot = amount_double.split(".")[1];
  if (!afterDot) afterDot = "000000000000";
  afterDot = afterDot?.padEnd(12, "0").slice(0, 12);
  let bigIntString = afterDot;
  if (beforeDot?.length && !beforeDot.startsWith("0"))
    bigIntString = beforeDot + afterDot;

  let amount = BigInt("0");
  try {
    amount = BigInt(bigIntString);
  } catch (error) {
    // in case the input is not a valid number,
    // the amount stays zero. Keeps the UI easy for copy and paste
  }
  return amount;
}
