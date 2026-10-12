import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const nativeKeys = promisify(execFile);

/** Observe real Orca output after native Firefox input. Never fabricate AT events or speech. */
export async function auditScreenReader({ client, execute, click, check, output, name, language }) {
  const logfile = process.env.ORCA_DEBUG_FILE;
  const read = () => readFile(logfile, "utf8");
  const initial = await read();
  if (!initial.includes("SPEECH: Using speech server factory:"))
    throw new Error("Orca has no verified speech backend; debug-only speech is insufficient");
  const popup = name.startsWith("popup");
  const username = popup ? "#quick-username" : "#field-proxy-username";
  const password = popup ? "#quick-password" : "#field-password";
  const save = popup ? "#quick-save" : "#save";
  const evidence = [];
  const speechLines = (text) => text.split("\n").filter((line) => line.includes("SPEECH OUTPUT:"));
  async function observe(action, perform, required, role = null) {
    const offset = (await read()).length;
    await perform();
    const until = Date.now() + 12000;
    let speech = [];
    while (Date.now() < until) {
      speech = speechLines((await read()).slice(offset));
      if (speech.some((line) => line.includes(required)) && (!role || role.test(speech.join("\n"))))
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const passed =
      speech.some((line) => line.includes(required)) && (!role || role.test(speech.join("\n")));
    evidence.push({ action, required, passed, speech });
    await writeFile(
      path.join(output, `${name}-${language}-orca.json`),
      JSON.stringify({ language, name, backendVerified: true, evidence }, null, 2),
    );
    check(passed, `Orca announces ${action} (${name}, ${language})`);
    if (!passed) throw new Error(`Orca did not announce ${action}: expected ${required}`);
    if (speech.some((line) => line.includes("fixture-password")))
      throw new Error("Orca spoke the synthetic password as plaintext");
  }
  const labels = await execute(
    `return arguments[0].map(selector=>{const e=document.querySelector(selector);return e.labels?.[0]?.textContent.trim()||e.textContent.trim();});`,
    [[username, password, save]],
  );
  // Stop Orca's automatic page read before editing, as a reader user would.
  // During SayAll Orca deliberately keeps browse mode and consumes letter keys.
  await nativeKeys("xdotool", ["key", "--clearmodifiers", "Control_L"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await observe("username label", () => click(username), labels[0]);
  await observe(
    "ordinary text key echo positive control",
    () => nativeKeys("xdotool", ["type", "--clearmodifiers", "q"]),
    "'q'",
  );
  await nativeKeys("xdotool", ["key", "--clearmodifiers", "BackSpace"]);
  await observe(
    "password label after Tab",
    () =>
      client.send("WebDriver:PerformActions", {
        actions: [
          {
            type: "key",
            id: "reader-keyboard",
            actions: [
              { type: "keyDown", value: "\uE004" },
              { type: "keyUp", value: "\uE004" },
            ],
          },
        ],
      }),
    labels[1],
    /password\s+text/i,
  );
  check(
    await execute("return document.activeElement===document.querySelector(arguments[0]);", [
      password,
    ]),
    "Native Tab reaches the protected password input",
  );
  const originalPassword = await execute("return document.querySelector(arguments[0]).value;", [
    password,
  ]);
  // Tab selects the existing password in Firefox. Collapse the selection before
  // appending the synthetic canary, so this audit cannot replace saved credentials.
  await nativeKeys("xdotool", ["key", "--clearmodifiers", "End"]);
  const passwordOffset = (await read()).length;
  await nativeKeys("xdotool", ["type", "--clearmodifiers", "--delay", "100", "qz97"]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const passwordSpeech = speechLines((await read()).slice(passwordOffset));
  const echoedSecret = passwordSpeech.some((line) =>
    /SPEECH OUTPUT: '(?:q|z|9|7|qz97)'(?:\s|$)/i.test(line),
  );
  evidence.push({
    action: "native password key echo",
    passed: !echoedSecret,
    speech: passwordSpeech,
  });
  check(!echoedSecret, "Orca does not echo native password canary characters");
  if (echoedSecret) throw new Error("Orca exposed a synthetic password character");
  await nativeKeys("xdotool", [
    "key",
    "--clearmodifiers",
    "BackSpace",
    "BackSpace",
    "BackSpace",
    "BackSpace",
  ]);
  const restoredPassword = await execute("return document.querySelector(arguments[0]).value;", [
    password,
  ]);
  check(
    restoredPassword === originalPassword,
    "Screen-reader canary preserves the original password",
  );
  if (restoredPassword !== originalPassword)
    throw new Error("Screen-reader audit changed the password; refusing to save");
  await observe("Save feedback", () => click(save), language === "zh_CN" ? "已保存" : "Saved");
}
