import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function filter(lines: string[]): unknown {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {nativeGraphicsDiagnostic as f} from "./scripts/fixtures/graphics-diagnostics.mjs"; console.log(JSON.stringify(JSON.parse(process.argv[1]).map(f)));',
        JSON.stringify(lines),
      ],
      { encoding: "utf8" },
    ),
  ) as unknown;
}

describe("synthetic map native graphics diagnostics", () => {
  it("keeps native driver messages and redacts extension origins", () => {
    expect(
      filter([
        "debug Firefox stderr: [GFX1-]: EGL allocation failed",
        "debug Firefox stderr: [GFX2-]: Failed to create GL context",
        "debug Firefox stdout: WebGL context lost moz-extension://abc-123/options.html",
      ]),
    ).toEqual([
      "[GFX1-]: EGL allocation failed",
      "[GFX2-]: Failed to create GL context",
      "WebGL context lost moz-extension://<extension>/options.html",
    ]);
  });
  it("drops raw debug and credential/header lines even with graphics keywords", () => {
    expect(
      filter([
        "debug extension manifest contains WebGL",
        "Firefox stderr: WebGL Authorization: Basic abc",
        "Firefox stderr: EGL Cookie: session=fixture",
        "Firefox stdout: Mesa fixture-password",
        "Firefox stdout: pthread Bearer abc",
        "Firefox stdout: unrelated native output",
      ]),
    ).toEqual([null, null, null, null, null, null]);
  });
});
