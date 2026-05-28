import { test, expect } from "bun:test";
import {
  getWalletSecret,
  walletRouteToString,
  walletRouteFromString,
  WALLET_DEFAULT_ROUTE,
} from "../dist/api";

function validSeedphrase(): string {
  // a valid 24-word bip39 seedphrase
  return "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
}

test("a: getWalletSecret with valid params returns 64 bytes", () => {
  const result = getWalletSecret({
    route: WALLET_DEFAULT_ROUTE,
    seedphrase: validSeedphrase(),
    coin_name: "monero",
    key_type: "spend",
  });
  expect(result.length).toBe(64);
  // different password gives different output
  const result2 = getWalletSecret({
    route: WALLET_DEFAULT_ROUTE,
    seedphrase: validSeedphrase(),
    password: "different",
    coin_name: "monero",
    key_type: "spend",
  });
  expect(result2.length).toBe(64);
  expect(result2).not.toEqual(result);
});

test("b: getWalletSecret rejects invalid inputs", () => {
  const base = {
    route: WALLET_DEFAULT_ROUTE,
    seedphrase: validSeedphrase(),
    coin_name: "monero" as const,
    key_type: "spend" as const,
  };

  // invalid seedphrase
  expect(() =>
    getWalletSecret({ ...base, seedphrase: "not a valid seedphrase" }),
  ).toThrow("invalid seedphrase");

  // password too long
  expect(() => getWalletSecret({ ...base, password: "x".repeat(101) })).toThrow(
    "invalid password",
  );

  // invalid coin_name
  expect(() =>
    getWalletSecret({ ...base, coin_name: "bitcoin" as any }),
  ).toThrow("Unsupported coin name");

  // invalid key_type
  expect(() =>
    getWalletSecret({ ...base, key_type: "invalid" as any }),
  ).toThrow("Unsupported key type");

  // invalid wallet_type in route
  expect(() =>
    getWalletSecret({
      ...base,
      route: { ...WALLET_DEFAULT_ROUTE, wallet_type: "invalid" as any },
    }),
  ).toThrow("Unsupported wallet type");

  // invalid wallet_slot
  expect(() =>
    getWalletSecret({
      ...base,
      route: { ...WALLET_DEFAULT_ROUTE, wallet_slot: "abc" },
    }),
  ).toThrow("Invalid wallet id");

  // non alphanumeric identity
  expect(() =>
    getWalletSecret({
      ...base,
      route: { ...WALLET_DEFAULT_ROUTE, identity: "bad id!" },
    }),
  ).toThrow("invalid identity");

  // identity too long (>20 chars)
  expect(() =>
    getWalletSecret({
      ...base,
      route: { ...WALLET_DEFAULT_ROUTE, identity: "a".repeat(21) },
    }),
  ).toThrow("invalid identity");

  // invalid domain (space)
  expect(() =>
    getWalletSecret({
      ...base,
      route: { ...WALLET_DEFAULT_ROUTE, domain: "bad domain" },
    }),
  ).toThrow("invalid domain");

  // empty identity (triggers !identity check, not isValidIdentity)
  expect(() =>
    getWalletSecret({
      ...base,
      route: { ...WALLET_DEFAULT_ROUTE, identity: "" },
    }),
  ).toThrow("Invalid wallet route");
});

test("c: walletRouteToString produces correct string", () => {
  const str = walletRouteToString(WALLET_DEFAULT_ROUTE);
  expect(str).toBe("main/no_domain/single/0");

  const custom = walletRouteToString({
    identity: "myid",
    domain: "example.com",
    wallet_type: "sa_multi",
    wallet_slot: "3",
  });
  expect(custom).toBe("myid/example.com/sa_multi/3");
});

test("d: walletRouteToString rejects invalid routes", () => {
  // identity too long
  expect(() =>
    walletRouteToString({
      ...WALLET_DEFAULT_ROUTE,
      identity: "a".repeat(21),
    }),
  ).toThrow("invalid identity");

  // non alphanumeric identity
  expect(() =>
    walletRouteToString({
      ...WALLET_DEFAULT_ROUTE,
      identity: "bad^id",
    }),
  ).toThrow("invalid identity");

  // invalid domain
  expect(() =>
    walletRouteToString({
      ...WALLET_DEFAULT_ROUTE,
      domain: "dom ain",
    }),
  ).toThrow("invalid domain");

  // invalid wallet_type
  expect(() =>
    walletRouteToString({
      ...WALLET_DEFAULT_ROUTE,
      wallet_type: "wrong" as any,
    }),
  ).toThrow("invalid wallet_type");

  // invalid wallet_slot (non numeric)
  expect(() =>
    walletRouteToString({
      ...WALLET_DEFAULT_ROUTE,
      wallet_slot: "abc",
    }),
  ).toThrow("invalid wallet_slot");
});

test("e: walletRouteFromString parses valid routes", () => {
  const r1 = walletRouteFromString("main/no_domain/single/0");
  expect(r1.ok).toBeTrue();
  if (r1.ok) {
    expect(r1.route.identity).toBe("main");
    expect(r1.route.domain).toBe("no_domain");
    expect(r1.route.wallet_type).toBe("single");
    expect(r1.route.wallet_slot).toBe("0");
  }

  const r2 = walletRouteFromString("custom/my-site.com/pl_multi/42");
  expect(r2.ok).toBeTrue();
  if (r2.ok) {
    expect(r2.route.wallet_type).toBe("pl_multi");
    expect(r2.route.wallet_slot).toBe("42");
  }
});

test("f: walletRouteFromString rejects invalid routes", () => {
  // missing segments
  expect(walletRouteFromString("only")).toEqual({
    ok: false,
    error: "missing domain",
  });
  expect(walletRouteFromString("a/b/c")).toEqual({
    ok: false,
    error: "missing wallet_slot",
  });
  // two segments (missing wallet_type)
  expect(walletRouteFromString("a/b")).toEqual({
    ok: false,
    error: "missing wallet_type",
  });
  // empty segment at start
  expect(walletRouteFromString("/a/b/c")).toEqual({
    ok: false,
    error: "missing identity",
  });

  // too many parts
  const tooMany = walletRouteFromString("a/b/single/0/extra");
  expect(tooMany.ok).toBeFalse();
  if (!tooMany.ok) expect(tooMany.error).toMatch("4 parts");

  // invalid wallet_type
  const badType = walletRouteFromString("a/b/wrong/0");
  expect(badType.ok).toBeFalse();
  if (!badType.ok) expect(badType.error).toMatch("invalid wallet_type");

  // invalid wallet_slot (non numeric)
  const badSlot = walletRouteFromString("a/b/single/abc");
  expect(badSlot.ok).toBeFalse();
  if (!badSlot.ok) expect(badSlot.error).toMatch("invalid wallet_slot");

  // negative wallet_slot
  const negSlot = walletRouteFromString("a/b/single/-1");
  expect(negSlot.ok).toBeFalse();
  if (!negSlot.ok) expect(negSlot.error).toMatch("< 0");

  // non-alphanumeric identity
  const badId = walletRouteFromString("bad^id/domain/single/0");
  expect(badId.ok).toBeFalse();
  if (!badId.ok) expect(badId.error).toMatch("invalid identity");

  // invalid domain
  const badDomain = walletRouteFromString("identity/dom ain/single/0");
  expect(badDomain.ok).toBeFalse();
  if (!badDomain.ok) expect(badDomain.error).toMatch("invalid domain");
});

test("g: round-trip walletRouteToString -> walletRouteFromString", () => {
  const routes = [
    WALLET_DEFAULT_ROUTE,
    {
      identity: "myid",
      domain: "example.com",
      wallet_type: "sa_multi" as const,
      wallet_slot: "3",
    },
    {
      identity: "test",
      domain: "sub.domain.org",
      wallet_type: "pl_multi" as const,
      wallet_slot: "99",
    },
  ];
  for (const route of routes) {
    const str = walletRouteToString(route);
    const parsed = walletRouteFromString(str);
    expect(parsed.ok).toBeTrue();
    if (parsed.ok) {
      expect(parsed.route).toEqual(route);
    }
  }
});
