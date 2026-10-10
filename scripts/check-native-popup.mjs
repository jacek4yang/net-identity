/** Native Firefox extension-menu popup, using Firefox's own WebDriver element actions.
 * This is a temporary-addon test. Signed installation is a separate release gate.
 */
export async function checkNativePopup(browser, proxyPort, expected) {
  const client = browser.client;
  await client.send("Marionette:SetContext", { value: "chrome" });
  async function chromeClick(selector) {
    const found = (
      await client.send("WebDriver:FindElement", { using: "css selector", value: selector })
    ).value;
    await client.send("WebDriver:ElementClick", {
      id: found["element-6066-11e4-a52e-4f735466cecf"],
    });
  }
  await chromeClick("#unified-extensions-button");
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = (
      await client.send("WebDriver:ExecuteScript", {
        script:
          'const e=document.getElementById("net-identity_jacek4yang_github_io-BAP"); return !!e && e.getBoundingClientRect().height > 0;',
        args: [],
      })
    ).value;
    if (ready) break;
    if (attempt === 99) throw new Error("Extension menu item did not become visible");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await chromeClick("#net-identity_jacek4yang_github_io-BAP");
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = (
      await client.send("WebDriver:ExecuteScript", {
        script:
          'return document.querySelector("browser.webextension-popup-browser")?.currentURI?.spec.endsWith("/popup/popup.html");',
        args: [],
      })
    ).value;
    if (ready) break;
    if (attempt === 99) throw new Error("Native popup did not open");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  async function popup(script, args = []) {
    const r = await browser.client.send("WebDriver:ExecuteAsyncScript", {
      script: `const done=arguments[arguments.length-1];const actor=document.querySelector("browser.webextension-popup-browser").browsingContext.currentWindowGlobal.getActor("MarionetteCommands"); (async()=>{${script}})().then(done,e=>done({error:String(e)}));`,
      args,
    });
    if (r.value?.error) throw Error(r.value.error);
    return r.value;
  }
  async function popupClick(selector) {
    return popup(
      'const e=await actor.findElement("css selector",arguments[0],{});await actor.clickElement(e,{toJSON:()=>({"moz:webdriverClick":true})});return true;',
      [selector],
    );
  }
  async function popupFill(selector, value) {
    return popup(
      'const e=await actor.findElement("css selector",arguments[0],{});await actor.clearElement(e);await actor.sendKeysToElement(e,arguments[1],{toJSON:()=>({"moz:webdriverClick":true})});return true;',
      [selector, value],
    );
  }
  async function popupRead(script, args = []) {
    return popup("return actor.executeScript(arguments[0],arguments[1],{});", [script, args]);
  }
  await popupClick("#quick-add-toggle");
  await popupFill("#quick-host", "127.0.0.1");
  await popupFill("#quick-port", String(proxyPort));
  await popupClick('[data-i18n="sessionAuth"]');
  await popupFill("#quick-username", expected.username);
  await popupFill("#quick-password", expected.password);
  await popupClick("#quick-save");
  for (let i = 0; i < 200; i++) {
    if (
      await popupRead(
        'return document.getElementById("quick-status").textContent.startsWith("Saved.");',
      )
    )
      break;
    if (i === 199) throw Error("native popup Save never finished");
    await new Promise((r) => setTimeout(r, 50));
  }
  const retained = await popupRead(
    'return document.getElementById("quick-username").value===arguments[0]&&document.getElementById("quick-password").value===arguments[1];',
    [expected.username, expected.password],
  );
  if (!retained) throw Error("native popup lost entered credentials");
  console.log(
    JSON.stringify({
      nativePopupSaved: true,
      credentialsRetained: retained,
      dimensions: await popupRead(
        "return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight};",
      ),
    }),
  );
  await popupClick("#quick-add-toggle");
  await popupClick("#quick-add-toggle");
  if (
    !(await popupRead('return document.getElementById("quick-password").value===arguments[0];', [
      expected.password,
    ]))
  )
    throw Error("native popup Back lost password");
  console.log(
    "PASS native Firefox popup real keystrokes, save, scrolling to buttons, Back and reopen",
  );
}
