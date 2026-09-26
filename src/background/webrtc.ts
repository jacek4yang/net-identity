/**
 * WebRTC IP handling policy.
 *
 * Firefox exposes this as a privacy setting
 * (`browser.privacy.network.webRTCIPHandlingPolicy`). Another extension or an
 * enterprise policy may control it; the `levelOfControl` value is checked first
 * and reported honestly instead of pretending the change succeeded.
 *
 * `default` is never replaced by default for direct profiles, and WebRTC is never
 * disabled entirely — `proxy_only` is offered as the strictest user-selectable
 * policy.
 */
import { describeError } from "../shared/result";
import { parseWebRtcPolicy } from "../shared/primitives";
import type { WebRTCPolicy } from "../profile/schema";
import type { WebRtcApplyStatus, WebRtcRuntimeState } from "../shared/state";

export interface WebRtcSettingLike {
  get(details: { incognito?: boolean }): Promise<{ value: unknown; levelOfControl: string }>;
  set(details: { value: unknown; scope?: string }): Promise<unknown>;
}

export interface WebRtcReadResult {
  value: string | undefined;
  levelOfControl: string;
}

export interface WebRtcController {
  read(): Promise<WebRtcReadResult>;
  apply(policy: WebRTCPolicy): Promise<WebRtcRuntimeState>;
}

export function createPendingWebRtcState(desired: WebRTCPolicy): WebRtcRuntimeState {
  return { desired, levelOfControl: "unknown", status: "pending" };
}

/** Used when the privacy API is unavailable in this Firefox build. */
export function createUnavailableWebRtcController(message: string): WebRtcController {
  return {
    async read() {
      return { value: undefined, levelOfControl: "unknown" };
    },
    async apply(policy) {
      return { desired: policy, levelOfControl: "unknown", status: "unsupported", message };
    },
  };
}

export function createWebRtcController(setting: WebRtcSettingLike): WebRtcController {
  const controller: WebRtcController = {
    async read() {
      try {
        const current = await setting.get({});
        return {
          value: typeof current.value === "string" ? current.value : undefined,
          levelOfControl:
            typeof current.levelOfControl === "string" ? current.levelOfControl : "unknown",
        };
      } catch {
        return { value: undefined, levelOfControl: "unknown" };
      }
    },

    async apply(policy: WebRTCPolicy): Promise<WebRtcRuntimeState> {
      const before = await controller.read();

      // Nothing could be read at all: never claim the change was applied or refused.
      if (before.value === undefined && before.levelOfControl === "unknown") {
        return {
          desired: policy,
          levelOfControl: before.levelOfControl,
          status: "error",
          message: "The WebRTC policy could not be read on this Firefox build.",
        };
      }

      if (before.levelOfControl === "not_controllable") {
        return {
          desired: policy,
          levelOfControl: before.levelOfControl,
          status: "not_controllable",
          message: "This Firefox build does not allow extensions to change the WebRTC policy.",
        };
      }

      if (before.levelOfControl === "controlled_by_other_extensions") {
        return {
          desired: policy,
          levelOfControl: before.levelOfControl,
          status: "controlled_by_other",
          ...(before.value === undefined ? {} : { actual: before.value }),
          message: "Another extension controls the WebRTC policy; net-identity did not change it.",
        };
      }

      if (before.value === policy) {
        return {
          desired: policy,
          levelOfControl: before.levelOfControl,
          status: "already",
          actual: policy,
        };
      }

      try {
        const applied = await setting.set({ value: policy });
        if (applied === false) {
          return {
            desired: policy,
            levelOfControl: before.levelOfControl,
            status: "error",
            message: "Firefox refused the WebRTC policy change.",
          };
        }
      } catch (error) {
        return {
          desired: policy,
          levelOfControl: before.levelOfControl,
          status: "error",
          message: describeError(error, "Firefox refused the WebRTC policy change."),
        };
      }

      const after = await controller.read();
      if (after.value === policy) {
        return {
          desired: policy,
          levelOfControl: after.levelOfControl,
          status: "applied",
          actual: policy,
        };
      }

      if (after.value === undefined) {
        return {
          desired: policy,
          levelOfControl: after.levelOfControl,
          status: "error",
          message: "Firefox accepted the change but did not report the resulting policy.",
        };
      }

      return {
        desired: policy,
        levelOfControl: after.levelOfControl,
        status: "unsupported",
        actual: after.value,
        message: `Firefox kept "${after.value}" instead of "${policy}".`,
      };
    },
  };

  return controller;
}

/** Best-effort read used for the audit without changing anything. */
export async function readWebRtcPolicy(setting: WebRtcSettingLike): Promise<WebRtcRuntimeState> {
  const controller = createWebRtcController(setting);
  const current = await controller.read();
  const parsed = parseWebRtcPolicy(current.value);
  return {
    desired: parsed.ok ? parsed.value : "default",
    levelOfControl: current.levelOfControl,
    status: "already",
    ...(current.value === undefined ? {} : { actual: current.value }),
  };
}

export function isWebRtcStatusApplied(status: WebRtcApplyStatus): boolean {
  return status === "applied" || status === "already";
}
