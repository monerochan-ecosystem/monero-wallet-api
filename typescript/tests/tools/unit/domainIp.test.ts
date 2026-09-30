import { test, expect } from "bun:test";
import { getDomainWithTLD } from "../../../dist/xmr3";

test("ipv4 literals return unchanged, not psl-chopped", () => {
  expect(getDomainWithTLD("10.20.30.1")).toBe("10.20.30.1");
  expect(getDomainWithTLD("192.168.1.1")).toBe("192.168.1.1");
});

test("loopback spellings merge into localhost", () => {
  expect(getDomainWithTLD("127.0.0.1")).toBe("localhost");
  expect(getDomainWithTLD("::1")).toBe("localhost");
  expect(getDomainWithTLD("[::1]")).toBe("localhost");
});

test("other ip literals return unchanged", () => {
  expect(getDomainWithTLD("fe80::1")).toBe("fe80::1");
  expect(getDomainWithTLD("10.20.30.1")).toBe("10.20.30.1");
});

test("normal names still use the psl", () => {
  expect(getDomainWithTLD("shop.example.co.uk")).toBe("example.co.uk");
  expect(getDomainWithTLD("co.uk.evil.com")).toBe("evil.com");
  expect(getDomainWithTLD("localhost")).toBe("localhost");
});
