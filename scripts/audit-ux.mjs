import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Scoped accessibility/interaction evidence, never loaded into the shipped extension. */
export async function auditUx({
  client,
  execute,
  click,
  waitFor,
  check,
  output,
  name,
  language,
  light,
}) {
  const axePath = require.resolve("axe-core/axe.min.js");
  const viewportMetrics = [];
  for (const width of [320, 500, 1280]) {
    await client.send("WebDriver:SetWindowRect", { width, height: 900 });
    viewportMetrics.push(
      await execute(
        `return {requested:arguments[0],innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth};`,
        [width],
      ),
    );
  }
  await client.send("WebDriver:SetWindowRect", {
    width: name.startsWith("options") ? 1280 : 500,
    height: 900,
  });
  await client.send("WebDriver:SetWindowRect", { width: 640, height: 900 });
  await client.send("Marionette:SetContext", { value: "chrome" });
  await client.send("WebDriver:ExecuteScript", {
    script: "gBrowser.selectedBrowser.browsingContext.fullZoom=2;",
    args: [],
  });
  await client.send("Marionette:SetContext", { value: "content" });
  await waitFor("return innerWidth <= 320;");
  const zoomed = await execute(
    "return {innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth};",
  );
  viewportMetrics.push({ zoom: 2, ...zoomed });
  check(!zoomed.overflow, "200% zoom at 320 CSS pixels has no horizontal overflow");
  await client.send("Marionette:SetContext", { value: "chrome" });
  await client.send("WebDriver:ExecuteScript", {
    script: "gBrowser.selectedBrowser.browsingContext.fullZoom=1;",
    args: [],
  });
  await client.send("Marionette:SetContext", { value: "content" });
  await client.send("WebDriver:SetWindowRect", {
    width: name.startsWith("options") ? 1280 : 500,
    height: 900,
  });
  const keyboard = [];
  await execute("document.activeElement?.blur(); window.scrollTo(0,0);");
  await click("h1");
  for (let step = 0; step < 40; step++) {
    await client.send("WebDriver:PerformActions", {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: "\uE004" },
            { type: "keyUp", value: "\uE004" },
          ],
        },
      ],
    });
    keyboard.push(
      await execute(
        `const e=document.activeElement;const r=e.getBoundingClientRect();const c=getComputedStyle(e);return {documentFocused:document.hasFocus(),focusVisible:e.matches(":focus-visible"),id:e.id,tag:e.tagName,outline:c.outlineStyle,outlineWidth:c.outlineWidth,visible:r.width>0&&r.height>0&&c.visibility!=="hidden",inView:r.bottom>0&&r.top<innerHeight};`,
      ),
    );
  }
  await writeFile(
    path.join(output, `${name}-${language}-keyboard.json`),
    JSON.stringify(keyboard, null, 2),
  );
  let feedback = null;
  if (name === "popup-auth-saved") {
    const times = [];
    const original = await execute(
      'return {user:document.getElementById("quick-username").value,password:document.getElementById("quick-password").value};',
    );
    for (let trial = 0; trial < 20; trial++) {
      await execute(
        `window.__feedback=null;document.getElementById("quick-add-toggle").addEventListener("click",()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__feedback=performance.now()-start));},{once:true,capture:true});`,
      );
      await click("#quick-add-toggle");
      await waitFor("return window.__feedback !== null;");
      times.push(await execute("return window.__feedback;"));
    }
    const retained = await execute(
      'return document.getElementById("quick-username").value===arguments[0].user && document.getElementById("quick-password").value===arguments[0].password;',
      [original],
    );
    const sorted = [...times].sort((a, b) => a - b);
    feedback = {
      samples: times,
      p50: sorted[9],
      p95: sorted[18],
      retained,
      method: "native click event to two animation frames; cloud headless environment",
    };
    check(retained, "Twenty native Back/reopen actions retain typed credentials");
  }
  await writeFile(
    path.join(output, `${name}-${language}-metrics.json`),
    JSON.stringify({ viewportMetrics, feedback }, null, 2),
  );
  await execute(await readFile(axePath, "utf8"));
  const audit = await client.send("WebDriver:ExecuteAsyncScript", {
    script: `const done = arguments[arguments.length - 1];
                      axe.run(document, {runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]}}).then(r=>done({violations:r.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary,checks:n.any}))})),passes:r.passes.length}),e=>done({error:String(e)}));`,
    args: [],
  });
  await writeFile(
    path.join(output, `${name}-${language}-${light ? "light" : "dark"}-axe.json`),
    JSON.stringify(audit.value ?? audit, null, 2),
  );

  const result = audit.value ?? audit;
  if (result.error) throw new Error(result.error);
  check(result.violations.length === 0, `No automatic WCAG A/AA violations (${name}, ${language})`);
  const unreviewed = result.incomplete.filter(
    (item) =>
      !(
        item.id === "color-contrast" &&
        item.nodes.every(
          (node) =>
            node.target.length === 1 && node.target[0] === 'legend[data-i18n="basicSection"]',
        )
      ),
  );
  check(
    unreviewed.length === 0,
    `No unreviewed scanner-incomplete findings (${name}, ${language})`,
  );
  const focused = keyboard.filter((item) => item.documentFocused && item.tag !== "BODY");
  check(
    focused.length > 0 &&
      focused.every(
        (item) => item.visible && item.inView && item.focusVisible && item.outline !== "none",
      ),
    `Focused keyboard samples are visible (${name}, ${language})`,
  );
}
