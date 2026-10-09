import { describe, expect, it } from "vitest";
import { createBuiltinDirectProfile } from "../src/profile/schema";
import { filterProfiles } from "../src/popup/profile-search";
import { quickProxyProfile } from "../src/profile/quick-proxy";

const create = (name: string, host: string, port: number) => {
  const result = quickProxyProfile({ type: "socks5", host, port }, name, `profile-${port}`, []);
  if (!result.ok) throw new Error(result.errors.join(" "));
  return result.value;
};
const profiles = [create("Tokyo", "proxy.example.com", 1080), create("本地", "::1", 10808)];

describe("display-only profile search", () => {
  it("keeps the original order and list for a blank query", () => {
    expect(filterProfiles(profiles, "  ")).toBe(profiles);
  });
  it("matches name, host, protocol and port with all literal terms", () => {
    expect(filterProfiles(profiles, "TOKYO socks5 1080")).toEqual([profiles[0]]);
    expect(filterProfiles(profiles, "本地 ::1")).toEqual([profiles[1]]);
    expect(filterProfiles(profiles, "proxy.example.com")).toEqual([profiles[0]]);
    expect(filterProfiles(profiles, ".*")).toEqual([]);
    expect(filterProfiles(profiles, "Tokyo ::1")).toEqual([]);
  });
  it("does not mutate profiles or evaluate arbitrary patterns", () => {
    const before = JSON.stringify(profiles);
    expect(filterProfiles(profiles, "<script>")).toEqual([]);
    filterProfiles(profiles, "a".repeat(100000));
    expect(JSON.stringify(profiles)).toBe(before);
  });
});

it("finds the built-in route by its displayed language without renaming stored profiles", () => {
  const direct = createBuiltinDirectProfile();
  const all = [direct, ...profiles];
  const before = JSON.stringify(all);
  expect(filterProfiles(all, "原有网络", "使用 Firefox 原有网络设置")).toEqual([direct]);
  expect(filterProfiles(all, "原有网络", "Use Firefox network settings")).toEqual([]);
  expect(JSON.stringify(all)).toBe(before);
});
