import { describe, expect, it } from "vitest";

import {
  cookieSecureForRequest,
  exposureVerdict,
  hostnameOf,
  isLoopbackHost,
  isPrivateHost,
} from "./host";

describe("hostnameOf", () => {
  it("strips the port", () => {
    expect(hostnameOf("192.168.1.5:3000")).toBe("192.168.1.5");
    expect(hostnameOf("localhost:3000")).toBe("localhost");
  });

  it("keeps a bare IPv6 address intact", () => {
    expect(hostnameOf("::1")).toBe("::1");
    expect(hostnameOf("fe80::1ff:fe23:4567")).toBe("fe80::1ff:fe23:4567");
  });

  it("unwraps bracketed IPv6 with a port", () => {
    expect(hostnameOf("[::1]:3000")).toBe("::1");
    expect(hostnameOf("[fe80::1]:8080")).toBe("fe80::1");
  });

  it("is null for nothing", () => {
    expect(hostnameOf(null)).toBeNull();
    expect(hostnameOf("")).toBeNull();
    expect(hostnameOf("   ")).toBeNull();
  });
});

describe("isLoopbackHost", () => {
  const yes = [
    "localhost", "localhost:3000", "app.localhost:3000",
    "127.0.0.1:3000", "127.1.2.3", "::1", "[::1]:3000",
    "0.0.0.0:3000",
  ];
  const no = [
    "192.168.1.5:3000", "10.0.0.4", "health.example.com",
    "jays-macbook-air.local:3000", null,
  ];

  for (const h of yes) it(`${h} is loopback`, () => expect(isLoopbackHost(h)).toBe(true));
  for (const h of no) it(`${h} is not loopback`, () => expect(isLoopbackHost(h)).toBe(false));
});

describe("isPrivateHost", () => {
  const yes = [
    "localhost:3000", "127.0.0.1", "::1",
    "10.0.0.4:3000", "192.168.1.5:3000",
    "172.16.0.1", "172.31.255.254",       // the /12 block's real edges
    "169.254.10.1",                        // link-local
    "jays-macbook-air.local:3000", "mac.local",
    "fd00::1", "fe80::1ff:fe23:4567",
  ];
  const no = [
    // 172.32 and 172.15 sit just outside the /12 and are ordinary public
    // addresses. Treating them as private would downgrade a real deployment's
    // cookie, which is the whole reason this boundary is tested.
    "172.32.0.1", "172.15.0.1",
    "8.8.8.8", "health.example.com", "example.local.com", null,
  ];

  for (const h of yes) it(`${h} is private`, () => expect(isPrivateHost(h)).toBe(true));
  for (const h of no) it(`${h} is not private`, () => expect(isPrivateHost(h)).toBe(false));
});

describe("cookieSecureForRequest", () => {
  it("is Secure behind a proxy that terminated TLS", () => {
    expect(cookieSecureForRequest("health.example.com", "https")).toBe(true);
    // Proxy chains append; the client-facing protocol is the first entry.
    expect(cookieSecureForRequest("health.example.com", "https,http")).toBe(true);
  });

  it("is Secure on a public host with no proxy header", () => {
    expect(cookieSecureForRequest("health.example.com", null)).toBe(true);
  });

  it("is not Secure on a LAN address over plain HTTP", () => {
    // The case that silently breaks login: the browser drops a Secure cookie
    // over http and the passphrase looks wrong.
    expect(cookieSecureForRequest("192.168.1.5:3000", null)).toBe(false);
    expect(cookieSecureForRequest("jays-macbook-air.local:3000", null)).toBe(false);
    expect(cookieSecureForRequest("localhost:3000", null)).toBe(false);
  });

  it("does not let a forged http header downgrade a public host", () => {
    expect(cookieSecureForRequest("health.example.com", "http")).toBe(true);
  });

  it("defaults closed when the host is unknown", () => {
    expect(cookieSecureForRequest(null, null)).toBe(true);
  });
});

describe("exposureVerdict", () => {
  const open = { authEnabled: false, allowInsecure: false };

  it("serves loopback with no passphrase", () => {
    expect(exposureVerdict({ host: "localhost:3000", ...open })).toBe("ok");
    expect(exposureVerdict({ host: "127.0.0.1:3000", ...open })).toBe("ok");
  });

  it("blocks a LAN address with no passphrase", () => {
    expect(exposureVerdict({ host: "192.168.1.5:3000", ...open })).toBe("blocked");
    expect(exposureVerdict({ host: "mac.local:3000", ...open })).toBe("blocked");
  });

  it("blocks a public host with no passphrase", () => {
    expect(exposureVerdict({ host: "health.example.com", ...open })).toBe("blocked");
  });

  it("serves anything once a passphrase is set", () => {
    expect(
      exposureVerdict({ host: "192.168.1.5:3000", authEnabled: true, allowInsecure: false }),
    ).toBe("ok");
  });

  it("honours the explicit override", () => {
    expect(
      exposureVerdict({ host: "192.168.1.5:3000", authEnabled: false, allowInsecure: true }),
    ).toBe("ok");
  });
});
