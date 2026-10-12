/** Real trusted-UI vault setup and suspension checks; fixture data only. */
export async function runVaultChecks({
  client,
  call,
  execute,
  click,
  fill,
  waitFor,
  check,
  optionsUrl,
  popupUrl,
}) {
  // Successful vault setup/unlock deliberately reloads the extension document.
  // Never click twice: only retry the read-only postcondition across that navigation.
  async function submitAndWaitForReload(condition) {
    await execute('document.documentElement.dataset.vaultNavigationWitness = "before-submit";');
    const navigation = (error) =>
      error instanceof Error && error.message.includes('"message":"Document was unloaded"');
    try {
      await click("#vault-submit");
    } catch (error) {
      if (!navigation(error)) throw error;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (
          await execute(
            'if (document.documentElement.dataset.vaultNavigationWitness === "before-submit") return false; ' +
              condition,
          )
        )
          return;
      } catch (error) {
        if (!navigation(error)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Vault reload did not reach its verified postcondition");
  }
  await client.send("WebDriver:Navigate", { url: optionsUrl });
  await waitFor('return !!document.getElementById("vault-panel");');
  const profile = {
    id: "vault-fixture",
    name: "Vault fixture profile",
    revision: 1,
    proxy: { type: "socks5", host: "127.0.0.1", port: 19999, proxyDNS: true, bypassHosts: [] },
    identity: {
      mode: "manual",
      geoIpPolicy: "disabled",
      latitude: 35,
      longitude: 139,
      accuracy: 20000,
      timezone: "Asia/Tokyo",
    },
    webrtcPolicy: "proxy_only",
  };
  check(
    (
      await call({
        type: "profiles:save",
        profile,
        credentials: { username: "vault-fixture-user", password: "vault-fixture-proxy-secret" },
      })
    ).ok,
    "Vault fixture profile saved without activation",
  );
  const before = await call({ type: "profiles:list" });
  await execute('document.getElementById("vault-panel").open = true;');
  await fill({
    "vault-password": "fixture master passphrase",
    "vault-confirm": "different master passphrase",
  });
  await click("#vault-submit");
  await waitFor('return !document.getElementById("vault-error").hidden;');
  check(
    (await call({ type: "vault:get" })).status === "unencrypted",
    "Mismatched master passwords never migrate data",
  );
  await fill({ "vault-confirm": "fixture master passphrase" });
  await submitAndWaitForReload(
    'return !!document.getElementById("vault-panel") && document.getElementById("vault-form").hidden;',
  );
  check(
    (await call({ type: "vault:get" })).status === "unlocked",
    "Actual form enables encrypted persistence",
  );
  check(
    JSON.stringify(await call({ type: "profiles:list" })) === JSON.stringify(before),
    "Setup preserves saved configuration and credential availability",
  );
  const backup = await call({ type: "vault:backup" });
  check(
    backup.ok &&
      backup.backup.includes('"ciphertext"') &&
      !backup.backup.includes("vault-fixture-proxy-secret"),
    "Export contains ciphertext only",
  );
  await client.send("WebDriver:Navigate", { url: popupUrl });
  await waitFor('return !!document.getElementById("vault-panel");');
  await waitFor(
    'return document.getElementById("vault-form").hidden && !document.querySelector("main").hidden;',
  );
  check(
    await execute(
      'return document.getElementById("vault-form").hidden && !document.querySelector("main").hidden;',
    ),
    "Popup shows encrypted-unlocked status without obstructing switching",
  );
  await client.send("WebDriver:Navigate", { url: optionsUrl });
  await client.send("WebDriver:ExecuteAsyncScript", {
    script: `const done = arguments[arguments.length - 1]; const api = (window.wrappedJSObject || window).browser; api.runtime.getBackgroundPage().then(bg => { bg.close(); done(true); });`,
    args: [],
  });
  check(
    (await call({ type: "vault:get" })).status === "unlocked",
    "Event-page suspension preserves the unlocked session",
  );
  // Model Firefox clearing memory-only storage on extension update. Actual full
  // restart and active-route leak sentinels have their separate harness.
  await client.send("WebDriver:ExecuteAsyncScript", {
    script: `const done = arguments[arguments.length - 1]; const api = (window.wrappedJSObject || window).browser; api.storage.session.clear().then(() => api.runtime.getBackgroundPage()).then(bg => { bg.location.reload(); done(true); });`,
    args: [],
  });
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await call({ type: "vault:get" })).status === "locked") {
      locked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!locked) throw new Error("Replacement event page did not observe the missing session key");
  await client.send("WebDriver:Navigate", { url: optionsUrl });
  await waitFor(
    'return !!document.getElementById("vault-panel") && document.querySelector("main").hidden;',
  );
  check(
    (await call({ type: "vault:get" })).status === "locked",
    "Missing session key locks controls without deleting data",
  );
  await fill({ "vault-password": "incorrect fixture master password" });
  await click("#vault-submit");
  await waitFor('return !document.getElementById("vault-error").hidden;');
  check(
    (await call({ type: "vault:get" })).status === "locked",
    "Actual UI rejects a wrong master password",
  );
  await fill({ "vault-password": "fixture master passphrase" });
  await submitAndWaitForReload(
    'return !!document.getElementById("vault-panel") && document.getElementById("vault-form").hidden && !document.querySelector("main").hidden;',
  );
  check(
    JSON.stringify(await call({ type: "profiles:list" })) === JSON.stringify(before),
    "Unlock preserves every profile and credential marker",
  );
  check(
    (await call({ type: "state:get" })).state.activeProfileId === null,
    "Previously Off stays Off after unlock",
  );
  for (const language of ["zh_CN", "en"]) {
    await fill({ "ui-language": language });
    await waitFor(
      `return document.documentElement.lang === ${JSON.stringify(language === "zh_CN" ? "zh-CN" : "en")};`,
    );
    await execute('document.getElementById("vault-panel").open = true;');
    check(
      await execute("return document.documentElement.scrollWidth <= innerWidth;"),
      `Vault controls contained (${language})`,
    );
  }
}
