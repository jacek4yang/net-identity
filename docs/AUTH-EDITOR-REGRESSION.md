# Authenticated proxy editor regression

## Confirmed release defect

On Firefox 157.0.1, release 1.2.0 reset both credential inputs and collapsed the
options authentication section after Save and after Save and enable. The popup
also reset its entire form on Save and erased credentials when returning to the
route list. This made correcting and reusing a partially completed setup confusing.
Direct SOCKS5 positive, rejected-password and corrected-password controls worked;
the editor regression must not be described as universal Firefox SOCKS failure.

## Behavior and boundaries

- Save and enable preserve the current draft, password masking and open controls.
- Repeated Save updates the same profile. Only explicit New profile resets a
  completed popup draft. Closing the popup/window still discards unsaved input.
- Reopening a saved options profile shows saved-authentication placeholders. Both
  empty fields keep the stored pair; stored secrets are never returned to the UI.
- A later async response cannot replace newer input or a different selection.
- Retaining input must not automatically send its credentials to a newly typed
  endpoint. Editing authentication or explicitly saving confirms the new binding.
- SOCKS5 rejects an empty username and credentials above 255 UTF-8 bytes before
  probing/saving. Supported empty passwords remain supported. HTTP limits remain
  separate. Username whitespace is not silently trimmed.
- Ordinary routing, credential redaction and encrypted storage are unchanged.
  Session-only mode still loses credentials on full Firefox exit; encrypted mode
  needs its master password after restart. No new credential persistence is added.

## Verification

`npm run check` includes protocol-boundary and draft-state regression cases.
`npm run e2e:draft -- --firefox <path>` now tests real editor input, auto preview,
wrong-password correction, Save, Save and enable, duplicate prevention, reopen,
unchanged stored credentials, popup back/return and explicit New profile. Its
loopback SOCKS/HTTP fixtures verify actual routing and authentication.

Run it with `--draft-evidence <directory>` and again with `--light` to capture
English/Chinese in both native themes, including narrow-layout assertions.

The required hosted Firefox workflow also runs vault UI/suspension, full browser
restart with and without the vault, HTTP auth, SOCKS auth, outage recovery,
WebSocket routing and privacy invariants. A local subset never substitutes for the
exact-commit hosted result. Publication and signed-package installation are
separate gates, not established by unsigned temporary-extension testing.
