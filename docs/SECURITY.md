# Security model

This document is the authoritative list of security invariants. Any change that weakens
one of them is a breaking change; update this file deliberately, with the tests that
enforce it (`tests/credentials.test.ts`, `tests/messages-router.test.ts`,
`tests/public-identity.test.ts`, `tests/proxy.test.ts`, `tests/activation.test.ts`).

## Invariants

1. **Proxy credentials never enter page context.**
   The MAIN world and every `window.postMessage` payload carry exactly
   `{ ns, generation, latitude, longitude, accuracy, timezone }`
   (`createPublicIdentity`), and `serializeForPage` is asserted against a whitelist of
   keys in tests.

2. **Proxy credentials are never persisted in `storage.local`.**
   Passwords live only under `ni.cred.v1.<profileId>` in `browser.storage.session`
   (`src/background/credentials.ts`), plus inside the session-only active-target
   snapshot. Tests serialise the local area and assert the password is absent.

3. **Proxy credentials are never logged.**
   Only `describeError()` output is ever logged, which redacts `Basic …`/`Bearer …`
   tokens and `(proxy-)authorization:`/`password:`/`token:` values. A proxy error
   containing a base64 credential is asserted to come out redacted.

4. **External GeoIP providers receive no explicit credentials.**
   The provider request is a `GET` with `credentials: "omit"`, `referrerPolicy:
"no-referrer"`, `cache: "no-store"` and a single `accept: application/json` header.
   Tests assert the request options.

5. **Content/page communication carries only public identity information.**
   The bridge posts nothing else, and ignores every page message except `hello` and
   `applied`. Page-supplied data is never treated as identity input — `applied` is an
   untrusted diagnostic used only to detect a stale injection.

6. **Incoming messages are validated.**
   `runtime.onMessage` rejects senders whose extension id is not ours, then validates the
   payload with `parseInboundMessage`, then validates the profile with `parseProfile`.
   Content-only messages (`content:hello`, `content:report`) are additionally required to
   come from a tab.

7. **External responses are treated as untrusted.**
   Every GeoIP field is validated; malformed optional fields are discarded, a malformed
   required field (`ip`) fails the lookup. Provider text is sanitised of control
   characters and length-capped before it reaches the UI.

8. **No telemetry exists.** There is no analytics, no crash reporting and no update
   ping. The only outbound request is the GeoIP lookup described above.

9. **No remote JavaScript is loaded.** Everything ships in the package; there is no
   `import()` of a remote URL and no `content_security_policy` relaxation.

10. **No `eval` or dynamic code execution.**
    `scripts/build.mjs` fails the build if `eval(` or `new Function(` appears in the
    background bundle.

## Additional protections

- **Origin vs proxy authentication.** `webRequest.onAuthRequired` returns credentials
  only when Firefox reports a proxy challenge (`isProxy === true`), the active profile is
  an HTTP/HTTPS proxy with stored credentials, and the challenger matches the configured
  proxy host or port. `WWW-Authenticate` challenges from websites can therefore never
  receive proxy credentials.
- **OTHER extensions cannot interfere.** `runtime.onMessage` ignores senders that are not
  this extension, including messages sent to this extension id by another add-on.
- **Reversibility.** The extension never writes Firefox's global proxy settings, so
  removing it (or deactivating a profile) restores the previous browser behaviour. The
  WebRTC policy is returned to `default` on deactivation.
- **Honest reporting.** If another extension controls the WebRTC policy, net-identity
  reports _controlled by another extension_ rather than claiming success. If Firefox
  itself has a proxy configured, the audit reports that a `direct` profile does not
  override it.

## Secret handling summary

| Secret                               | Where it lives                                            | Lifetime            | Reaches page context?                            |
| ------------------------------------ | --------------------------------------------------------- | ------------------- | ------------------------------------------------ |
| Proxy password                       | `storage.session` (`ni.cred.v1.*`, `ni.active-target.v1`) | until Firefox exits | never                                            |
| Proxy username                       | profile in `storage.local`                                | persistent          | never                                            |
| GeoIP location data                  | profile in `storage.local`                                | persistent          | only coordinates/accuracy/timezone, deliberately |
| Client certificate, cookies, history | not touched                                               | —                   | —                                                |

There is no key material, no signing, no native messaging and no local server.

## Platform trust boundary

Firefox's `storage.session` is restricted to trusted extension contexts
(`TRUSTED_CONTEXTS`), so content scripts cannot read it. Firefox clears it when the
browser exits, which is also the documented guarantee given to users in the UI
("Stored only for the current Firefox session.").

## Data collection declaration

The manifest declares:

```json
"data_collection_permissions": {
  "required": ["locationInfo"],
  "optional": ["personallyIdentifyingInfo"]
}
```

Reasoning, so a reviewer can verify it:

- Automatic identity mode sends an HTTPS request to a third-party GeoIP provider
  (`https://ipwho.is/…`) and stores the returned location data. That is location data
  collected and transmitted off the device, so `none` would be false.
- `personallyIdentifyingInfo` is listed as _optional_ because, with a **proxied**
  profile, the IP the provider sees belongs to the proxy, while with a **direct**
  profile it is the user's own address. The user chooses that mode per profile.
- `tests/manifest.test.ts` asserts that the declaration exists, uses only documented
  categories and is not `["none"]` while an automatic provider exists.

If you add another provider, re-review this declaration, this document, the README and
the test. `docs/ROADMAP.md` tracks making the provider selectable so the declaration can
stay accurate per configuration.
