# Quick setup, migration and troubleshooting

[简体中文](QUICKSTART.zh-CN.md) · [Project](../README.md)

This guide describes the 1.2.0 source. Check AMO for the currently published version.
Use your own proxy; Net Identity does not provide proxy servers or a VPN service.

## Add and use a proxy

1. Open Net Identity, choose **Add Proxy**, and enter a host and port.
2. Check the protocol. A bare address uses the visible SOCKS5 choice; an explicit URL
   scheme takes precedence. Examples: `127.0.0.1:10808`, `http://proxy.example.com:8080`,
   `socks5://[2001:db8::1]:1080`. There is no network-based protocol guessing.
3. If required, expand authentication and enter the username and password.
   Do not paste them into a URL. SOCKS4 has no authentication support in Firefox.
4. A complete endpoint automatically checks its observed exit IP, approximate location and
   timezone through that draft proxy before you save. Existing browsing keeps its active
   route; no draft credentials or profile are saved by the check. Options with Public IP /
   GeoIP set to Disabled do not schedule checks; popup quick setup previews by design.
5. **Save** stores the profile without changing the route. **Save and enable** saves the
   visible form and activates it. A valid address or successful preview is not activation.
6. Inspect the route status and identity diagnostics separately. An active route does
   not prove that GeoIP resolved or every frame accepted the identity shim.

A new proxy uses strict proxy-only WebRTC and automatic location/timezone. SOCKS DNS
is enabled by default. Existing profiles retain their explicit settings. Strict WebRTC
may prevent calls without a TURN-over-TCP route through the proxy; adjust that policy
explicitly if your compatibility needs differ. This does not cover all browser/system traffic.

## Daily use

Click a saved profile once to switch. Search by name, host, port or protocol without
changing routing. **Off** releases identity/WebRTC control. **Browser / System routing**
uses the existing Firefox/system route, which can itself contain another proxy.

In Settings, **Save** stores changes without activation; **Save and enable** saves and
activates the current visible form. Selecting a saved profile uses its saved revision.
Refresh uses the applied configuration. Duplicate never copies secrets. Leaving both
authentication fields blank on Save preserves existing stored credentials.

Before vault setup, closing Firefox loses session credentials; re-enter both fields and
enable the profile. With **Protect saved profiles** enabled, profiles and separate
saved/applied credentials persist encrypted behind a master password. Unlock after a
full Firefox restart to restore the applied snapshot; newer saved edits stay unapplied.
Export an encrypted backup outside the Firefox profile. The master password cannot be
reset, and backup restore is allowed only into an empty installation. See
[encrypted storage and recovery](ENCRYPTED-VAULT.md).

Language selection is independent of network identity. Advanced controls expose DNS,
bypasses, manual coordinates, timezone and WebRTC. The online map is optional: first
loading it discloses your network-visible IP/viewed area to OpenFreeMap and remembers
automatic loading for later visible map openings. Each opening rechecks route, credentials
and consent. Unload or unchecking automatic loading clears the preference. The local
grid and coordinate fields work without network map data.

## Migrate from another extension

Keep a copy of your existing settings. Copy the protocol, host and port into a new profile;
enter credentials separately. Do not run competing proxy controllers while validating the
new route. Compare the observed exit and the policy diagnostics before retiring the old setup.

No FoxyProxy or SwitchyOmega file-import compatibility is claimed yet. No private storage
is read from another extension. Never attach credential-bearing exports to a public issue.

## Common questions

- **Saved, but nothing changed?** Save is intentionally non-activating. Select the profile
  or choose Save and enable to use the current form.
- **Proxy works but identity is partial?** GeoIP can fail independently. Check its diagnostic,
  connectivity and any required consent; do not assume a routing bypass.
- **No internet after browser restart?** Unlock the vault if you enabled it. Otherwise,
  session passwords are gone: enter matching credentials and Save and enable. Missing
  credentials do not silently switch ordinary observed traffic to Direct. Firefox-protected
  services remain outside complete extension control; servers must reject anonymous access.
- **Forgot the master password?** There is no password-reset service. Backups require the
  same password. Keep the password and an encrypted backup somewhere independently accessible.
- **Map is blank?** The initial default is an offline coordinate grid. Online data needs
  explicit first enablement or your remembered loading preference, plus a permitted working
  route. Coordinates remain usable when imagery fails.
- **A call no longer connects?** Strict proxy-only WebRTC requires a suitable proxy/TURN TCP
  path. Choose a less restrictive policy only with awareness of the privacy trade-off.
- **Why isn't Direct direct?** It leaves Firefox/system proxy configuration in effect.
- **Why the Mozilla security notice?** Signing and ordinary approval do not equal active
  monitoring or a Recommended badge. See the public security and release records.

## Report a problem safely

Include extension/Firefox versions, OS, protocol, steps, expected versus actual behavior,
and sanitized diagnostic codes. Remove usernames, passwords, tokens, personal IPs and
private endpoints. Report security vulnerabilities through [SECURITY.md](../SECURITY.md).
