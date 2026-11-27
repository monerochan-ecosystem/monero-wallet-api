// the checkout page module, built once in production mode.
// bun test sets NODE_ENV=test. mininext then builds in dev mode and writes
// a .mininext-*.html file into standard-checkout. tests write only to test-data.
const before = Bun.env.NODE_ENV;
Bun.env.NODE_ENV = "production";
export const page = await import("../../../standard-checkout/page");
if (before === undefined) delete Bun.env.NODE_ENV;
else Bun.env.NODE_ENV = before;
