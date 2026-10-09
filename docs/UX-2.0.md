# Net Identity 2.0 interaction decisions (work in progress)

The current published version remains 1.1.5. This document describes candidate work,
not public AMO availability. Existing extension identity and signed artifacts are immutable.

## First slice: quick proxy setup

The popup already supports one-click switching, Off and expandable diagnostics. Keep
those paths. Add Host/Port setup directly in the popup using the existing profile
validation and save/activate message protocol. Save must never activate or start a
GeoIP lookup. Save & Activate is an explicit save followed by the established apply
path; routing and optional identity results remain separately visible.

Bare endpoints use the visible SOCKS5 selection; explicit schemes win. IPv6 in a
combined endpoint must be bracketed. No protocol probing occurs. Credential-bearing
URIs are rejected without echoing their contents; use the session-only fields instead.
Unknown schemes, paths, percent encodings and malformed ports are rejected. Duplicate
endpoints are allowed (different accounts/policies can legitimately share an endpoint);
new automatic names are unique, while a duplicate explicit name asks for a rename.
Background validation remains authoritative for profile limits and credentials.

## Public workflow comparison

Reviewed 2026-10-08:

- [Firefox connection settings](https://support.mozilla.org/en-US/kb/connection-settings-firefox)
  teach hostname/port and distinguish browser/system routing. Preserve that familiar
  vocabulary and do not describe our Direct profile as bypassing an external system proxy.
- [FoxyProxy help](https://getfoxyproxy.org/help/) separates the manager from supplied proxy
  services. Net Identity also requires the user's own proxy; do not imply bundled VPN service.
- [Original SwitchyOmega repository](https://github.com/FelisCatus/SwitchyOmega) explicitly
  reports that it is no longer maintained. Treat it as migration context, not evidence of
  a currently supported Firefox import format. No third-party import adapter is claimed.

Further competitor screenshots and maintained alternatives need review before the full
migration guide. No third-party code or visual assets were copied.

## Remaining slices

- Single-source English/Simplified Chinese catalogs, manual language override, packaged
  Firefox locales, localized machine-error presentation and layout coverage.
- Search and refined advanced controls, safe previewed credential-free local import/export.
- Paired public documentation, unobtrusive LINUX DO link, accurate AMO metadata and real
  Firefox screenshots. Live listing changes only describe approved public functionality.

## Verification

Use the existing quality and real-Firefox gates. Quick-parser unit tests and a real popup
Save regression extend them. Local Firefox absence is not a browser pass. Test narrow
layouts and scaling before claiming visual completion. Full bilingual coverage and live
AMO publication are not implemented by this first slice.

### Localization foundation (candidate slice 2)

The production package now includes `_locales/en` and `_locales/zh_CN`, and localized
manifest name/description. A popup language selector supports Auto, English and 简体中文.
Auto uses Firefox's UI locale, with English fallback; manual preference is stored under
`ni.ui.language.v1`, separate from profile state. It updates text and `html lang` without
reloading the popup or changing the active route. Existing typed values remain untouched.
The packaged catalogs are also the manual-override source, not parallel translations.

This slice translates static popup/quick-add controls and known status messages. Options,
onboarding, dynamic audit explanations and the complete backend error presentation remain
to be localized; the product is **not yet fully bilingual**. Stable machine identifiers,
proxy hosts, coordinates and IANA timezones are not translated. Unknown diagnostics remain
visible rather than being replaced with misleading success or an unrelated translation.

### Focused popup interaction (candidate slice 3)

The default popup prioritizes route search and switching. Search is literal and bounded
(128 characters), matching profile name, protocol, host and port without changing routing.
A no-match state explicitly says that the active route is unchanged. Off stays reachable;
long profile lists scroll within the switcher. Language selection moves to the footer.

Add Proxy now opens a focused setup view instead of inserting a long form above the
identity card. Back restores the switcher, retains the non-secret endpoint draft and clears
both credential fields. Host receives focus on entry; Back receives focus on return.
Protocol and port share one row; session authentication remains collapsed. Save and
Save & Activate retain their existing distinct semantics. Runtime warnings and the header
remain available during setup. These are popup changes only; options and full localization
remain work in progress.

### Options localization (candidate slice 4)

Options now reads the same language preference and translates core form controls,
accessibility labels, onboarding, consent-independent help, and supported runtime/map
messages. Changing language preserves unsaved field values and does not apply a route.
Open UI surfaces observe only the dedicated language preference; profile and credential
storage changes are not consumed by this listener. Unknown backend diagnostics retain
their original text. Composite privacy copy, some validation messages and detailed audit
values still need complete coverage before claiming a fully bilingual product.
