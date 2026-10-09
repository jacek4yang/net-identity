# Quick setup, migration and troubleshooting

[简体中文](QUICKSTART.zh-CN.md) · [Project](../README.md)

The popup quick-add and bilingual interface described here are candidate-branch features,
not a claim that the public AMO version already contains them. Use your own proxy.

## Add and use a proxy

1. Open Net Identity, choose **Add Proxy**, and enter a host and port.
2. Check the protocol. A bare address uses the visible SOCKS5 choice; an explicit URL
   scheme takes precedence. Examples: `127.0.0.1:10808`, `http://proxy.example.com:8080`,
   `socks5://[2001:db8::1]:1080`. There is no network-based protocol guessing.
3. If required, expand session authentication and enter the username and password.
   Do not paste them into a URL. SOCKS4 has no authentication support in Firefox.
4. **Save** stores the profile without changing the route. **Save & Activate** explicitly
   applies it. Saving a syntactically valid address does not establish connectivity.
5. Inspect the route status and identity diagnostics separately. An active route does
   not prove that GeoIP resolved or every frame accepted the identity shim.

A new proxy uses strict proxy-only WebRTC and automatic location/timezone. SOCKS DNS
is enabled by default. Existing profiles retain their explicit settings. Strict WebRTC
may prevent calls without a TURN-over-TCP route through the proxy; adjust that policy
explicitly if your compatibility needs differ. This does not cover all browser/system traffic.

## Daily use

Click a saved profile once to switch. Search by name, host, port or protocol without
changing routing. **Off** releases identity/WebRTC control. **Browser / System routing**
uses the existing Firefox/system route, which can itself contain another proxy.

In Settings, **Save** stores changes; **Apply** uses the saved revision. Unsaved edits
stay in the form. Refresh uses the applied configuration. Duplicate never copies secrets.
Closing Firefox loses session credentials; re-enter both fields and apply the profile.
Leaving both fields blank on Save preserves existing session credentials.

Language selection is independent of network identity. Advanced controls expose DNS,
bypasses, manual coordinates, timezone and WebRTC. The online map is optional: its
explicit load action discloses your visible IP/viewed area to the provider. The local
grid and coordinate fields work without loading it.

## Migrate from another extension

Keep a copy of your existing settings. Copy the protocol, host and port into a new profile;
enter credentials separately. Do not run competing proxy controllers while validating the
new route. Compare the observed exit and the policy diagnostics before retiring the old setup.

No FoxyProxy or SwitchyOmega file-import compatibility is claimed yet. No private storage
is read from another extension. Never attach credential-bearing exports to a public issue.

## Common questions

- **Saved, but nothing changed?** Save is intentionally non-activating. Select the profile
  or Apply the saved revision.
- **Proxy works but identity is partial?** GeoIP can fail independently. Check its diagnostic,
  connectivity and any required consent; do not assume a routing bypass.
- **No internet after browser restart?** Session passwords are gone. Enter the matching
  credentials and Apply. Missing credentials must not silently switch to Direct.
- **Map is blank?** The default is an offline coordinate grid. Online data needs an explicit
  load and a working route; coordinates remain usable when imagery fails.
- **A call no longer connects?** Strict proxy-only WebRTC requires a suitable proxy/TURN TCP
  path. Choose a less restrictive policy only with awareness of the privacy trade-off.
- **Why isn't Direct direct?** It leaves Firefox/system proxy configuration in effect.
- **Why the Mozilla security notice?** Signing and ordinary approval do not equal active
  monitoring or a Recommended badge. See the public security and release records.

## Report a problem safely

Include extension/Firefox versions, OS, protocol, steps, expected versus actual behavior,
and sanitized diagnostic codes. Remove usernames, passwords, tokens, personal IPs and
private endpoints. Report security vulnerabilities through [SECURITY.md](../SECURITY.md).
