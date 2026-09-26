import { describe, expect, it } from "vitest";
import {
  createUnavailableWebRtcController,
  createWebRtcController,
} from "../src/background/webrtc";
import { createFakeWebRtcSetting } from "./helpers";

describe("WebRTC controller", () => {
  it("applies a policy when Firefox allows it", async () => {
    const setting = createFakeWebRtcSetting({ value: "default" });
    const outcome = await createWebRtcController(setting).apply("disable_non_proxied_udp");

    expect(outcome.status).toBe("applied");
    expect(outcome.actual).toBe("disable_non_proxied_udp");
    expect(setting.stored.value).toBe("disable_non_proxied_udp");
  });

  it("recognises an already-correct policy without writing", async () => {
    const setting = createFakeWebRtcSetting({ value: "disable_non_proxied_udp" });
    const outcome = await createWebRtcController(setting).apply("disable_non_proxied_udp");

    expect(outcome.status).toBe("already");
    expect(setting.setCalls).toBe(0);
  });

  it("does not pretend to change a policy another extension controls", async () => {
    const setting = createFakeWebRtcSetting({
      value: "default",
      levelOfControl: "controlled_by_other_extensions",
    });
    const outcome = await createWebRtcController(setting).apply("disable_non_proxied_udp");

    expect(outcome.status).toBe("controlled_by_other");
    expect(outcome.levelOfControl).toBe("controlled_by_other_extensions");
    expect(setting.setCalls).toBe(0);
  });

  it("reports a policy that this build cannot control", async () => {
    const setting = createFakeWebRtcSetting({
      value: "default",
      levelOfControl: "not_controllable",
    });
    const outcome = await createWebRtcController(setting).apply("proxy_only");

    expect(outcome.status).toBe("not_controllable");
    expect(setting.setCalls).toBe(0);
  });

  it("reports an error when Firefox refuses the write", async () => {
    const setting = createFakeWebRtcSetting({ value: "default" });
    setting.failNextSet = true;
    const outcome = await createWebRtcController(setting).apply("proxy_only");

    expect(outcome.status).toBe("error");
    expect(setting.stored.value).toBe("default");
  });

  it("reports an error when the setting throws", async () => {
    const setting = createFakeWebRtcSetting({ value: "default" });
    setting.throwNextSet = true;
    const outcome = await createWebRtcController(setting).apply("proxy_only");

    expect(outcome.status).toBe("error");
    expect(outcome.message).toBeDefined();
  });

  it("reports unsupported when Firefox keeps a different value", async () => {
    const values = { stored: "default" };
    const outcome = await createWebRtcController({
      get: async () => ({ value: values.stored, levelOfControl: "controllable_by_this_extension" }),
      set: async () => undefined, // accepts the call but does not change anything
    }).apply("disable_non_proxied_udp");

    expect(outcome.status).toBe("unsupported");
    expect(outcome.actual).toBe("default");
  });

  it("reports errors instead of throwing when the setting cannot be read", async () => {
    const outcome = await createWebRtcController({
      get: async () => {
        throw new Error("no privacy API");
      },
      set: async () => undefined,
    }).apply("proxy_only");

    expect(outcome.status).toBe("error");
    expect(outcome.levelOfControl).toBe("unknown");
  });

  it("reads the current value", async () => {
    const setting = createFakeWebRtcSetting({ value: "proxy_only" });
    const current = await createWebRtcController(setting).read();

    expect(current).toEqual({
      value: "proxy_only",
      levelOfControl: "controllable_by_this_extension",
    });
  });

  it("degrades gracefully when the privacy API is missing entirely", async () => {
    const controller = createUnavailableWebRtcController("not available");
    expect((await controller.read()).value).toBeUndefined();
    const outcome = await controller.apply("proxy_only");
    expect(outcome.status).toBe("unsupported");
    expect(outcome.message).toBe("not available");
  });
});
