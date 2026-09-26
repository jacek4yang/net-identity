# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's private
vulnerability reporting on this repository (Security → _Report a vulnerability_), or
contact the maintainer listed in `.github/CODEOWNERS` directly.

Include, as far as you can:

- what the issue is and which file/function is involved,
- how to reproduce it (Firefox version, profile configuration, pages involved),
- what an attacker gains — for example whether a proxy credential could be exposed, a
  page could observe something it should not, or traffic could leave the proxy
  unexpectedly.

You can expect an acknowledgement within a few days. This is a volunteer project, so
fixes are best-effort, but credential exposure and proxy-bypass issues are treated as
the highest priority.

## Scope

In scope:

- proxy credential exposure (local storage, logs, page context, GeoIP providers),
- proxy bypass: traffic leaving outside the configured proxy, including when the
  background page is suspended and restarted,
- page-context leakage of non-identity data (proxy host, credentials, profile list),
- authentication confusion between origin (`WWW-Authenticate`) and proxy
  (`Proxy-Authenticate`) challenges,
- spoofing or tampering that survives validation (messages, stored state, provider
  responses),
- the manifest's declared permissions and data-collection declaration being inaccurate.

Out of scope:

- the page shims being _detectable_ — they are page-visible by design and documented as a
  compatibility shim, not as fingerprinting protection,
- GeoIP data being approximate — that is documented behaviour,
- third-party GeoIP providers retaining the egress IP they are asked about — this is
  documented as a privacy consideration, and no credentials are sent,
- vulnerabilities in Firefox itself (please report those to Mozilla).

## Supported versions

Only the current `main` branch is supported. Releases are cut from `main`; if you use a
packaged build, please reproduce the issue against the latest commit before reporting.

## Security invariants

The authoritative list of invariants, and the tests that enforce them, is in
[`docs/SECURITY.md`](docs/SECURITY.md). Contributions that touch credentials, the proxy
engine, the page shims or the manifest permissions should be reviewed against that list.
