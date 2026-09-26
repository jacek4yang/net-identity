# Roadmap

Ordered by value, with the current state of each item. Nothing here is promised:
an item is "done" when it is implemented, tested and documented.

## Now / next

### 1. Selectable GeoIP providers (currently hard-wired)

Today the provider is fixed to `ipwho.is` (`createDefaultGeoIpProvider()`), and the
manifest declares the data collection accordingly. To make this safe to extend:

- add a per-profile provider selection (`ipwho.is`, `ipapi.co`, custom HTTPS endpoint);
- validate that a custom endpoint is `https:` and that its host is covered by the
  declared host permissions;
- surface the exact provider host in the audit, so the user can see who is contacted;
- re-review the AMO declaration for each new provider and update
  `tests/manifest.test.ts`.

The provider interface (`src/geo/provider.ts`) already isolates parsing and failure
handling, so this is mostly UI, configuration and documentation work.

### 2. Coverage for the page shims' remaining semantics

- patch `navigator.permissions.query({ name: "geolocation" })` so pages that gate on the
  permission state behave predictably;
- optionally patch subframes (`all_frames: true`) behind a per-profile option, with a
  measured cost, since subframe scripts see the same APIs.

### 3. Profile import/export

Export profiles as JSON **without** credentials (the model has no password field, so this
is naturally safe), import with validation through `parseProfile`, and refuse files with
unknown schema versions. Credentials must be re-entered after import.

### 4. Manual verification of challenge-based proxy authentication

`webRequest.onAuthRequired` matching is unit tested, but a real `407` requires a proxy
that demands authentication. `scripts/dev-proxy.mjs --require-auth user:pass` exists for
this; the remaining work is to record the outcome in `docs/MANUAL-TESTING.md` once
verified against a real profile.

## Later

### 5. Per-tab identity

Give different tabs different identities. This needs `proxy.onRequest` decisions keyed by
`details.tabId`, a per-tab WebRTC policy story (the Firefox setting is global, so it
would have to be documented as a limitation), and per-tab content-script broadcasts.

### 6. Identity change history

Keep a small, local history of identity changes (timestamp, profile, observed IP) so a
user can tell whether an activation actually changed the egress address. Purely local,
never transmitted.

### 7. AMO submission

- confirm the data-collection declaration with Mozilla's current requirements;
- provide reviewer notes explaining the GeoIP call and the page shims;
- write listing copy that avoids absolute claims about anonymity.

### 8. Firefox for Android

`gecko_android` is not declared, so the extension is desktop-only. The proxy and privacy
APIs exist on Android, but the popup/options experience and the `proxy.onRequest` host
permission story need testing before claiming support.

## Explicitly not planned

- Chrome/Edge/Safari support: `proxy.onRequest`, blocking `webRequest` and
  `world: "MAIN"` content scripts have no equivalent there, and a lowest-common
  denominator version would be worse for Firefox users.
- Any form of "anti-detect"/"undetectable" claim. The goal is consistency among the
  things the extension controls, with honest reporting of what it cannot control.
- Telemetry or remote configuration.
