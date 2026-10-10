# Visual and interaction acceptance

This is an acceptance contract, not a claim of WCAG conformance or proof of bug-free behavior.

## Standards and scope

Use [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level A/AA as the accessibility baseline. Automated findings require manual review; screen-reader and real-toolbar-popup behavior need their own evidence. A screenshot or a zero-violation scanner alone is insufficient.

Record the exact extension commit, Firefox version/channel, OS, viewport, scale, language, theme, test input class, result and evidence for each case. Never record user credentials. Use synthetic accounts against an independent SOCKS implementation as well as deterministic fault fixtures.

## Required matrix

- English and Simplified Chinese; native light and dark themes.
- Popup switcher, quick-add and authentication; options list/editor, privacy, vault setup/unlock and errors.
- Empty, loading, success, invalid input, wrong credentials, offline, recovery and locked-vault states.
- Normal desktop, narrow settings (320 CSS px), 200% text/zoom and reduced-motion preference. A resized normal tab is not proof that Firefox's native popup sizing works.

## Measurable acceptance

| Area               | Required evidence / acceptance                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text contrast      | Normal text >=4.5:1; large text >=3:1; review composited backgrounds and applicable exceptions.                                                                                                                                                               |
| Controls and focus | Relevant non-text contrast >=3:1; visible keyboard focus never entirely obscured.                                                                                                                                                                             |
| Target size        | WCAG 2.5.8 minimum 24x24 CSS px or a documented spacing/other exception; prefer larger primary targets without bloating the popup.                                                                                                                            |
| Reflow             | No lost controls, clipped messages or two-dimensional scrolling at 320 CSS px except content covered by a standard exception.                                                                                                                                 |
| Keyboard           | All tasks complete with Tab/Shift+Tab/Enter/Space/Escape as applicable; no traps; predictable focus after Back, errors and destructive confirmation.                                                                                                          |
| Labels / errors    | Every control has a programmatic name; required input and validation errors are explicit; status changes are exposed without stealing focus. No untranslated system messages.                                                                                 |
| Data preservation  | Zero silent loss of entered fields or saved configuration in every tested interruption/retry/upgrade path. Explicit New/clear is distinguishable from Back.                                                                                                   |
| Routing integrity  | Preview never changes active route; Save does not imply Enable; late responses cannot overwrite newer edits; endpoint edits never auto-forward retained credentials to a different proxy.                                                                     |
| Repeat actions     | Repeated Save/Enable creates one intended profile and one consistent active revision; pending operations provide feedback and cannot corrupt state.                                                                                                           |
| Recovery           | Correcting bad credentials and restoring the same proxy works without recreating a profile; no automatic direct fallback or replay of failed non-idempotent requests.                                                                                         |
| Persistence        | Browser restart with vault locked blocks authenticated use; explicit unlock restores saved configuration; ordinary upgrade preserves schema and encrypted data.                                                                                               |
| Responsiveness     | Record action-to-visible-feedback p50/p95 over >=20 runs on a named environment. Project target p95 <=250ms for local UI feedback; report server/network latency separately. This is a project target, not a WCAG threshold or flaky wall-clock CI assertion. |
| Task efficiency    | Record steps for add authenticated proxy, correct password, switch profile and unlock. Extra re-entry and duplicated actions are failures; improvements compared with the released version require measured baselines.                                        |

## Evidence and release decision

Keep PASS, FAIL, NOT RUN and BLOCKED separate. State the tested scope rather than asserting that all paths are covered. Any unresolved data-loss, credential disclosure, route-leak, keyboard-blocking or critical workflow defect blocks release. Report remaining lower-severity issues explicitly. Signed-package installation, actual toolbar popup, assistive-technology review and owner acceptance cannot be replaced by temporary-addon tests.

## 2026-10-10 measured baseline

Firefox 157.0.1 on the isolated Linux cloud test environment; synthetic accounts only. Runtime baseline is PR #94 head `107b51eb62a06a754593511030042be6d2e119b5`, followed by the control-border palette change in this revision. Do not transfer these findings to an untested later runtime.

- axe-core 4.14.0, WCAG A/AA tag set through 2.2: 16 combinations of options/popup × automatic-preview/auth-saved × EN/ZH × dark/light, zero automatically determined violations. The Chinese fieldset legend has a contrast _incomplete_ finding because the scanner cannot determine its partially overlapping fieldset background. Manual palette review gives text contrast >=12.59:1 against either adjacent background; this is documented review, not deletion of the scanner warning.
- Input boundary contrast: light >=3.27:1, dark >=4.07:1 against the tested input/container backgrounds. Palette regression tests enforce >=3:1. Decorative separators retain their softer colors.
- Four language/theme combinations, 20 native Back/reopen clicks each: credentials retained in all 80 actions; event-to-two-animation-frame p95 23–31ms (headless, no claim about every user's machine). This measures local feedback, not network completion or human task success.
- Actual 200% browser zoom at 320 CSS pixels: both languages, options/popup and preview/auth-saved states showed zero horizontal overflow in the dark-theme pass. Initial window-only requests for 320 were clamped by Firefox to 500; those were explicitly not counted as 320-pixel evidence.
- Independent, unmodified microsocks server with mandatory authentication: real Firefox options-editor Save-and-enable, incorrect/corrected passwords, 24 concurrent requests, three stop/restart cycles, same-endpoint credential replacement and whitespace/Unicode all passed. Server bound only to loopback, no auth-once whitelist. This is not remote-WAN qualification.

### Still not established

Native toolbar-popup sizing and scrolling in a regular signed installation; full screen-reader navigation; all forced-colors states; every import/upgrade path; actual owner remote-proxy performance; comparative human task completion against v1.2.0. Do not label this a full WCAG compliance audit or a complete usability certification. Publication remains a separate decision.

## Persistent regression gates

The shared Firefox workflow runs these checks on pull requests and release tags:

- `node scripts/e2e-ui.mjs --draft-check --ux-audit --draft-evidence artifacts/ux-dark --firefox "$firefox"`
- The same command with `--light` and a separate evidence directory.
- `node scripts/e2e-microsocks.mjs --microsocks /usr/bin/microsocks --firefox "$firefox"`

The UX audit preserves axe results (including reviewed incomplete findings), actual viewport/zoom measurements, keyboard samples and repeated-action latency in CI artifacts. It rejects newly determined violations, unreviewed incomplete findings, lost credentials, missing keyboard focus and horizontal overflow at the tested zoom. Local timing is recorded rather than used as a brittle runner-speed assertion.

The independent microsocks check uses mandatory synthetic username/password authentication, real Firefox options-editor actions and HTTP transfers. Negative credentials must fail before corrected credentials succeed. It covers concurrent requests, daemon outage/recovery, credential replacement and Unicode/whitespace. A separate native extension-menu popup check uses Firefox WebDriver key/click actions to exercise Save, scrolling, Back and reopening in the actual popup document. Temporary-addon evidence does not replace signed-install qualification.

These gates cover the stated paths, not every possible human interaction. Release approval remains conditional on closing the required acceptance gaps above; a green workflow is not permission to relabel NOT RUN as PASS.
