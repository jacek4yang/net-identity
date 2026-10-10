import { describe, expect, it } from "vitest";
import { parseCredentials } from "../src/profile/validation";
import { credentialsIntentFrom, toFormValues } from "../src/options/form";
import { parseDraftRequest } from "../src/shared/draft-probe";

describe("SOCKS5 authentication boundaries", () => {
  it("preserves whitespace in the options editor", () => {
    expect(
      credentialsIntentFrom({ ...toFormValues(null), proxyUsername: " user ", password: " pass " }),
    ).toEqual({ action: "set", username: " user ", password: " pass " });
  });
  it("rejects an empty username instead of silently negotiating anonymous SOCKS", () => {
    expect(parseCredentials({ username: "", password: "secret" }, "socks5").ok).toBe(false);
    expect(parseCredentials({ username: "", password: "secret" }, "http").ok).toBe(true);
  });
  it("uses UTF-8 byte lengths and keeps supported empty passwords", () => {
    expect(parseCredentials({ username: "用户", password: "密".repeat(85) }, "socks5").ok).toBe(
      true,
    );
    expect(parseCredentials({ username: "用户", password: "密".repeat(86) }, "socks5").ok).toBe(
      false,
    );
    expect(parseCredentials({ username: "密".repeat(86), password: "pass" }, "socks5").ok).toBe(
      false,
    );
    expect(parseCredentials({ username: "user", password: "x".repeat(255) }, "socks5").ok).toBe(
      true,
    );
    expect(parseCredentials({ username: "user", password: "x".repeat(256) }, "socks5").ok).toBe(
      false,
    );
    expect(parseCredentials({ username: "user", password: "" }, "socks5").ok).toBe(true);
  });
  it("rejects invalid authentication before a draft probe can send traffic", () => {
    expect(
      parseDraftRequest({
        type: "draft:probe",
        owner: "auth-test",
        input: {
          proxy: { type: "socks5", host: "127.0.0.1", port: 1080, proxyDNS: true, bypassHosts: [] },
          credentials: { username: "", password: "secret" },
        },
      }).ok,
    ).toBe(false);
  });
});

it("accepts the full SOCKS5 username boundary", () => {
  expect(parseCredentials({ username: "x".repeat(255), password: "ok" }, "socks5").ok).toBe(true);
  expect(parseCredentials({ username: "x".repeat(256), password: "ok" }, "socks5").ok).toBe(false);
});
