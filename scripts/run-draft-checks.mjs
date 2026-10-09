/** Actual editor and browser routing assertions, used only by the local fixture harness. */
export async function runDraftChecks({
  capture,
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
  await click("#new-profile");
  const before = (await call({ type: "state:get" })).state;
  await fill({ "field-proxy-host": "127.0.0.1", "field-proxy-port": String(fixture.b) });
  await waitFor('return document.getElementById("draft-status").dataset.state === "success";', 300);
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
  await call({ type: "profiles:deactivate" });
}
