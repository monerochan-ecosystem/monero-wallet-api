import { test, expect } from "bun:test";

//  code from jsonEndpoints.ts
type R<T> = { success: true; data: T } | { success: false; error: Error };
type Infer<T> = T extends (x: unknown) => infer R ? R : never;

function obj<T extends Record<string, any>>(s: {
  [K in keyof T]: (x: unknown) => T[K];
}) {
  function p(d: unknown): T {
    if (typeof d !== "object" || d === null) throw 0;
    const r = {} as T;
    for (const k in s) (r as any)[k] = s[k]((d as any)[k]);
    return r;
  }
  p.safeParse = (d: unknown): R<T> => {
    try {
      return { success: true, data: p(d) };
    } catch {
      return { success: false, error: new Error() };
    }
  };
  return p as ((x: unknown) => T) & { safeParse(x: unknown): R<T> };
}
const str = (x: unknown) => {
  if (typeof x !== "string") throw 0;
  return x;
};
const num = (x: unknown) => {
  if (typeof x !== "number") throw 0;
  return x;
};
const bool = (x: unknown) => {
  if (typeof x !== "boolean") throw 0;
  return x;
};
const lit =
  <T extends string>(v: T) =>
  (x: unknown) => {
    if (x !== v) throw 0;
    return v;
  };
const arr =
  <T>(f: (x: unknown) => T) =>
  (x: unknown) => {
    if (!Array.isArray(x)) throw 0;
    return x.map(f);
  };
const opt =
  <T>(f: (x: unknown) => T) =>
  (x: unknown) =>
    x === undefined ? undefined : f(x);
// end of code from jsonEndpoints.ts

const TestSchema = obj({
  id: str,
  jsonrpc: lit("2.0"),
  result: obj({
    height: num,
    status: str,
    fees: opt(arr(num)),
  }),
});

test("positive: valid payload parses successfully", () => {
  const payload = {
    id: "0",
    jsonrpc: "2.0",
    result: { height: 42, status: "OK", fees: [1, 2, 3] },
  };
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.result.height).toBe(42);
    expect(r.data.result.fees).toEqual([1, 2, 3]);
  }
});

test("positive: optional field omitted parses successfully", () => {
  const payload = {
    id: "0",
    jsonrpc: "2.0",
    result: { height: 1, status: "OK" },
  };
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.result.fees).toBeUndefined();
});

test("negative: wrong primitive type fails (number instead of string)", () => {
  const payload = {
    id: 0,
    jsonrpc: "2.0",
    result: { height: 1, status: "OK" },
  };
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(false);
});

test("negative: wrong array element type fails", () => {
  const payload = {
    id: "0",
    jsonrpc: "2.0",
    result: { height: 1, status: "OK", fees: [1, "bad", 3] },
  };
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(false);
});

test("negative: missing required field fails", () => {
  const payload = {
    jsonrpc: "2.0",
    result: { height: 1, status: "OK" },
  };
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(false);
});

test("negative: array passed where object expected fails", () => {
  const payload: unknown = [];
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(false);
});

test("negative: string passed where object expected fails", () => {
  const payload = "malicious";
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(false);
});

test("blank: null fails", () => {
  const r = TestSchema.safeParse(null);
  expect(r.success).toBe(false);
});

test("blank: undefined fails", () => {
  const r = TestSchema.safeParse(undefined);
  expect(r.success).toBe(false);
});

test("blank: empty object fails", () => {
  const r = TestSchema.safeParse({});
  expect(r.success).toBe(false);
});

test("blank: empty string fails", () => {
  const r = TestSchema.safeParse("");
  expect(r.success).toBe(false);
});

test("negative: literal mismatch fails", () => {
  const payload = {
    id: "0",
    jsonrpc: "1.0",
    result: { height: 1, status: "OK" },
  };
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(false);
});

test("negative: object passed where array expected fails", () => {
  const payload = {
    id: "0",
    jsonrpc: "2.0",
    result: { height: 1, status: "OK", fees: { not: "array" } },
  };
  const r = TestSchema.safeParse(payload);
  expect(r.success).toBe(false);
});
