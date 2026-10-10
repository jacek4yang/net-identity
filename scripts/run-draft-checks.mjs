/** Actual editor and browser routing assertions, used only by the local fixture harness. */
export async function runDraftChecks({
  capture,
  delayedInit = false,
  client,
  execute,
  call,
  click,
  fill,
  waitFor,
  check,
  fixture,
  optionsUrl,
  popupUrl,
}) {
  await client.send("WebDriver:Navigate", { url: optionsUrl });
  await waitFor('return !!document.getElementById("new-profile");');
  if (delayedInit) await waitFor('return document.documentElement.dataset.startupGate === "held";');
  await click("#new-profile");
  const before = (await call({ type: "state:get" })).state;
  await fill({ "field-proxy-host": "127.0.0.1", "field-proxy-port": String(fixture.b) });
  await waitFor('return document.getElementById("draft-status").dataset.state === "success";', 300);
  if (delayedInit) {
    await execute('document.dispatchEvent(new Event("ni-test-release-startup"));');
    await waitFor('return document.documentElement.dataset.startupGate === "settled";');
    const preserved = await execute(
      `return !document.getElementById("profile-form").hidden &&
      document.getElementById("field-proxy-host").value === "127.0.0.1" &&
      document.getElementById("field-proxy-port").value === arguments[0] &&
      document.getElementById("draft-status").dataset.state === "success";`,
      [String(fixture.b)],
    );
    check(preserved, "Late initialization preserves early proxy input and completed preview");
    if (!preserved) throw new Error("Late initialization discarded the user's new proxy draft");
  }
  const preview = await execute(
    'return {text: document.getElementById("draft-status").textContent, zone:document.getElementById("field-timezone").value, latitude:document.getElementById("field-latitude").value};',
  );
  check(
    preview.text.includes("203.0.113.42") &&
      preview.zone === "Asia/Tokyo" &&
      preview.latitude === "35.68",
    "Typing SOCKS5 endpoint automatically previews real fixture egress/location/timezone without Save or Apply",
  );
  const unchanged = (await call({ type: "state:get" })).state;
  check(
    unchanged.generation === before.generation &&
      unchanged.activeProfileId === before.activeProfileId,
    "Draft preview never changes active identity or routing generation",
  );
  check(
    (await call({ type: "profiles:list" })).profiles.length === 1,
    "Draft preview does not persist a profile",
  );
  await capture?.("options-auto-preview-zh");
  await click("#save-activate");
  await waitFor(
    'return document.getElementById("options-status").textContent.includes("Asia/Tokyo");',
    300,
  );
  const enabled = (await call({ type: "state:get" })).state;
  check(
    enabled.proxy.port === fixture.b && enabled.identity.publicIp === "203.0.113.42",
    "One Save and enable click commits a new unnamed draft and resolves active identity again",
  );
  const saved = (await call({ type: "profiles:list" })).profiles.find(
    (item) => item.id === enabled.activeProfileId,
  );
  const activeA = {
    ...saved,
    id: "fixture-route-a",
    name: "Active A",
    proxy: { ...saved.proxy, port: fixture.a },
    identity: { ...saved.identity, geoIpPolicy: "disabled" },
  };
  await call({ type: "profiles:save", profile: activeA });
  await call({ type: "profiles:activate", profileId: activeA.id });
  const baseline = (await call({ type: "state:get" })).state;
  await click("#new-profile");
  await fill({ "field-proxy-host": "127.0.0.1", "field-proxy-port": String(fixture.b) });
  await waitFor('return document.getElementById("draft-status").dataset.state === "success";', 300);
  const after = (await call({ type: "state:get" })).state;
  check(
    after.generation === baseline.generation && after.proxy.port === fixture.a,
    "Testing B leaves already-active A unchanged",
  );
  const priorA = fixture.seen.a.length;
  const originalWindowResult = await client.send("WebDriver:GetWindowHandle");
  const originalWindow = originalWindowResult.value ?? originalWindowResult;
  const ordinaryWindow = await client.send("WebDriver:NewWindow", { type: "tab" });
  await client.send("WebDriver:SwitchToWindow", {
    handle: (ordinaryWindow.value ?? ordinaryWindow).handle,
  });
  await client.send("WebDriver:Navigate", { url: "https://ipwho.is/?ordinary=" + Date.now() });
  const ordinaryText = await execute("return document.body.textContent;");
  check(
    ordinaryText.includes("203.0.113.42") && fixture.seen.a.length > priorA,
    "Ordinary page navigation still travels through A after the draft used B",
  );
  await client.send("WebDriver:CloseWindow");
  await client.send("WebDriver:SwitchToWindow", { handle: originalWindow });
  await click("#section-auth > summary");
  await fill({
    "field-proxy-port": String(fixture.auth),
    "field-proxy-username": "fixture-user",
    "field-password": "wrong",
  });
  await waitFor('return document.getElementById("draft-status").dataset.state === "error";', 300);
  check(
    await execute('return document.getElementById("field-password").value === "wrong";'),
    "Authentication failure preserves input for correction",
  );
  await fill({ "field-password": "fixture-password" });
  await waitFor('return document.getElementById("draft-status").dataset.state === "success";', 300);
  check(
    fixture.seen.auth.some((entry) => entry.accepted === true) &&
      fixture.seen.auth.some((entry) => entry.accepted === false),
    "SOCKS5 draft authenticates and recovers after the password is corrected",
  );
  const authenticatedProfile = {
    ...saved,
    id: "fixture-saved-auth",
    name: "Saved authenticated proxy",
    proxy: { ...saved.proxy, port: fixture.auth, authenticationRequired: true },
  };
  await call({
    type: "profiles:save",
    profile: authenticatedProfile,
    credentials: { username: "fixture-user", password: "fixture-password" },
  });
  const authBefore = fixture.seen.auth.length;
  const changedTarget = await call({
    type: "draft:probe",
    owner: "changed-endpoint-test",
    input: {
      profileId: authenticatedProfile.id,
      proxy: { ...authenticatedProfile.proxy, port: fixture.b },
    },
  });
  check(
    changedTarget.ok === false &&
      changedTarget.error === "credentials" &&
      fixture.seen.auth.length === authBefore,
    "Saved credentials are never reused automatically for a newly typed endpoint",
  );
  await fill({
    "field-password": "",
    "field-proxy-username": "",
    "field-proxy-type": "http",
    "field-proxy-port": String(fixture.http),
  });
  await waitFor('return document.getElementById("draft-status").dataset.state === "success";', 300);
  check(fixture.seen.http.length > 0, "HTTP draft preview uses a local CONNECT proxy");
  await fill({ "field-proxy-type": "socks5", "field-proxy-port": String(fixture.closedPort) });
  await waitFor('return document.getElementById("draft-status").dataset.state === "error";', 300);
  check(
    (await call({ type: "state:get" })).state.proxy.port === fixture.a,
    "Unreachable draft never falls back to A or switches the active route",
  );
  await fill({ "field-proxy-port": String(fixture.b) });
  await waitFor('return document.getElementById("draft-status").dataset.state === "success";', 300);
  await client.send("WebDriver:Navigate", { url: popupUrl });
  await waitFor('return !!document.getElementById("quick-add-toggle");');
  await click("#quick-add-toggle");
  await fill({ "quick-host": "127.0.0.1", "quick-port": String(fixture.b) });
  await waitFor(
    'return document.getElementById("quick-draft-status").dataset.state === "success";',
    300,
  );
  check(
    await execute(
      'return document.getElementById("quick-draft-status").textContent.includes("203.0.113.42");',
    ),
    "Popup quick-add also automatically checks the unactivated draft",
  );
  await capture?.("popup-auto-preview-zh");
  const stored = await client.send("WebDriver:ExecuteAsyncScript", {
    script:
      "const done=arguments[arguments.length-1]; browser.storage.local.get(null).then(v=>done(JSON.stringify(v)));",
    args: [],
  });
  check(
    !stored.value.includes("fixture-password") && !stored.value.includes("fixture-user"),
    "Draft authentication is absent from durable storage",
  );
  await click("#quick-add-toggle");
  check(
    (await call({ type: "state:get" })).state.generation === baseline.generation,
    "Closing draft editor leaves active A intact after success and failures",
  );
  // Real user flow: enter credentials, save, correct, enable, reopen and retry.
  await client.send("WebDriver:Navigate", { url: optionsUrl });
  await waitFor('return !!document.getElementById("new-profile");');
  await click("#new-profile");
  await fill({
    "field-name": "Auth editor regression",
    "field-proxy-host": "127.0.0.1",
    "field-proxy-port": String(fixture.auth),
  });
  await click("#section-auth > summary");
  await fill({ "field-proxy-username": "fixture-user", "field-password": "wrong" });
  await waitFor('return document.getElementById("draft-status").dataset.state === "error";', 300);
  const countBefore = (await call({ type: "profiles:list" })).profiles.length;
  await click("#save");
  await waitFor('return !document.getElementById("remove-credentials-row").hidden;');
  check(
    await execute(
      'return document.getElementById("field-proxy-username").value === "fixture-user" && document.getElementById("field-password").value === "wrong" && document.getElementById("section-auth").open;',
    ),
    "Save retains typed authentication and the expanded editor",
  );
  await fill({ "field-password": "fixture-password" });
  await waitFor('return document.getElementById("draft-status").dataset.state === "success";', 300);
  await click("#save-activate");
  await waitFor(
    'return !document.getElementById("profile-form").inert && document.getElementById("options-status").textContent.includes("Asia/Tokyo");',
    300,
  );
  check(
    await execute(
      'return document.getElementById("field-password").value === "fixture-password" && document.getElementById("field-proxy-username").value === "fixture-user";',
    ),
    "Save and enable retains credentials after successful authentication",
  );
  check(
    (await call({ type: "profiles:list" })).profiles.length === countBefore + 1,
    "Save then enable updates one profile instead of duplicating it",
  );
  const activated = (await call({ type: "state:get" })).state;
  check(
    activated.proxy.port === fixture.auth && activated.identity.publicIp === "203.0.113.42",
    "Edited credentials really authenticate the active route and fetch identity",
  );
  const changedEndpointBefore = fixture.seen.b.length;
  await fill({ "field-proxy-port": String(fixture.b) });
  await waitFor('return document.getElementById("draft-status").dataset.state === "error";', 300);
  check(
    fixture.seen.b.length === changedEndpointBefore,
    "Changing endpoint does not automatically forward the retained account to the new proxy",
  );
  check(
    await execute('return document.getElementById("field-password").value === "fixture-password";'),
    "Endpoint edit preserves the user's text while requiring authentication confirmation",
  );
  await fill({ "field-proxy-port": String(fixture.auth), "field-password": "fixture-password" });
  await waitFor('return document.getElementById("draft-status").dataset.state === "success";', 300);
  await capture?.("options-auth-saved");
  await client.send("WebDriver:Navigate", { url: optionsUrl });
  if (delayedInit) {
    await waitFor('return document.documentElement.dataset.startupGate === "held";');
    await execute('document.dispatchEvent(new Event("ni-test-release-startup"));');
    await waitFor('return document.documentElement.dataset.startupGate === "settled";');
  }
  await waitFor('return !!document.querySelector("[data-profile-id]");');
  await execute(`document.querySelector('[data-profile-id="' + arguments[0] + '"]').click();`, [
    activated.activeProfileId,
  ]);
  await waitFor('return document.getElementById("field-password").placeholder.length > 0;');
  check(
    await execute(
      'return document.getElementById("field-password").value === "" && document.getElementById("section-auth").open;',
    ),
    "Reopening shows saved-authentication placeholders without exposing the stored password",
  );
  await click("#save-activate");
  await waitFor('return !document.getElementById("profile-form").inert;', 300);
  check(
    (await call({ type: "state:get" })).state.identity.publicIp === "203.0.113.42",
    "Reopened editor can save and enable using its unchanged stored credentials",
  );
  await client.send("WebDriver:Navigate", { url: popupUrl });
  await waitFor('return !!document.getElementById("quick-add-toggle");');
  await click("#quick-add-toggle");
  await execute('document.querySelector("#quick-username").closest("details").open = true;');
  await fill({
    "quick-host": "127.0.0.1",
    "quick-port": String(fixture.auth),
    "quick-username": "fixture-user",
    "quick-password": "fixture-password",
  });
  await waitFor(
    'return document.getElementById("quick-draft-status").dataset.state === "success";',
    300,
  );
  await click("#quick-add-toggle");
  await click("#quick-add-toggle");
  check(
    await execute('return document.getElementById("quick-password").value === "fixture-password";'),
    "Back to routes and returning preserves the unfinished popup authentication draft",
  );
  const popupCount = (await call({ type: "profiles:list" })).profiles.length;
  await click("#quick-save");
  await waitFor('return !document.getElementById("quick-add-fields").disabled;');
  check(
    await execute('return document.getElementById("quick-password").value === "fixture-password";'),
    "Popup Save preserves the account and endpoint for correction or enable",
  );
  await click("#quick-save-activate");
  await waitFor('return !document.getElementById("quick-add-fields").disabled;', 300);
  check(
    (await call({ type: "profiles:list" })).profiles.length === popupCount + 1,
    "Repeated popup Save and enable do not duplicate the profile",
  );
  check(
    (await call({ type: "state:get" })).state.identity.publicIp === "203.0.113.42",
    "Popup authenticated route works after separate Save and enable",
  );
  await capture?.("popup-auth-saved");
  await click("#quick-new");
  check(
    await execute(
      'return document.getElementById("quick-password").value === "" && document.getElementById("quick-host").value === "";',
    ),
    "Only explicit New profile clears the completed popup draft",
  );
  await call({ type: "profiles:deactivate" });
}
