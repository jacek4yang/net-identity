# Encrypted profiles and upgrade safety

The candidate adds an optional local master-password vault. Enable it from **Protect
saved profiles** in the popup or settings. Existing installations keep their data and
routing; an upgrade never invents a password or silently discards configuration.
Before setup, profiles are unencrypted and proxy credentials remain session-only.

## What changes after setup

- Saved profiles, separately applied configuration, saved proxy credentials and the
  applied credential snapshot are encrypted together. A newer saved-but-unapplied
  endpoint/password cannot replace the active route after restart.
- AES-256-GCM authenticates each revision, with a new random 96-bit nonce per write.
  A random 128-bit salt and PBKDF2-HMAC-SHA-256 (600,000 iterations) derive the key
  from the master password. Native WebCrypto performs all cryptography.
- The master password is never stored, logged, sent to a provider or included in a
  backup. The derived key exists in trusted extension memory/storage.session only,
  allowing an MV3 event-page restart without another password prompt.
- Full Firefox exit, extension disabling or updating may clear the session key.
  Unlock once again; the encrypted profiles and credentials remain on disk.
- Until unlocked, a previously active route blocks extension-observable ordinary
  requests. Previously Off remains Off. This is not an OS firewall: Firefox-protected
  internal traffic lies outside the extension's complete cancellation control.
- Unlock restores the applied snapshot; it does not automatically apply newer saved
  edits, reinterpret manual coordinates/timezone, or claim a fresh observed exit IP.
  Refresh remains explicit. Network recovery itself does not change storage or keys.

## Upgrade and failure contract

The versioned envelope is stored under ni.vault.v1. A separate encrypted previous
revision is retained on each successful write. The old ni.state.v1 becomes a non-secret
schema-5 sentinel, so older schema-4 builds refuse to replace it with empty profiles.
Language and map-autoload preferences remain non-secret local UI settings. A single
on/off bit and cryptographic metadata are visible outside the ciphertext; profile
names, endpoints, coordinates and credentials are encrypted.

Initial setup validates existing profiles and credentials, encrypts and decrypt-verifies
the new representation, then writes the vault and legacy sentinel in one storage call.
Legacy session entries are removed only after durable read-back verification and session
key storage. Unsupported/future schemas, damaged ciphertext, wrong passwords and write
failures produce errors, never an automatic empty replacement or unencrypted downgrade.
This is logical migration, not a forensic secure erase of historical filesystem blocks.

All vault mutations use one serialized writer; there is no background retry that can
replace newer configuration. Authentication covers format metadata and the on/off bit.
Before unlock the on/off bit cannot be authenticated; this feature protects encrypted
contents at rest, not a profile directory already controlled by an attacker.

## Backups and recovery

Download an encrypted backup after setup and important edits. Keep it outside the
Firefox profile. The previous encrypted revision can also be downloaded. Backups require
the same master password; there is no password reset service, backdoor or recovery key.
Losing both the password and an independently accessible copy means losing access.

Restore is explicit and allowed only into an empty installation. It validates and
successfully decrypts the complete backup before writing anything. It never overwrites
existing profiles or a vault. Restoring resumes the route recorded in the backup.
Uninstalling the extension, clearing its data or deleting the Firefox profile can still
remove storage; normal extension updates preserve durable data. Keep a backup first.

## Security limits

At-rest encryption does not encrypt SOCKS/HTTP proxy authentication on the network,
protect an already-unlocked compromised browser/OS, prevent keylogging, or make a weak
master password strong. JavaScript cannot guarantee physical erasure of every string
copy. Only the plaintext byte buffers are explicitly cleared after cryptographic use.
No external password service, native messaging host, new permission or runtime dependency
is introduced. Content scripts and web pages cannot invoke the trusted vault protocol.

## Validation

- vault-crypto/store tests: authentication tampering, future formats, wrong passwords,
  failure preservation, parallel writes, backup restore, session/full-exit behavior,
  applied-versus-saved credentials and route preservation.
- Real Firefox vault UI: setup confirmation, encrypted-only export, event-page reload,
  missing session key, wrong/correct unlock, Off preservation and bilingual layout.
- Real Firefox authenticated-proxy full restart: locked HTTP/HTTPS/WS/WSS/DNS traffic,
  zero ordinary direct leakage, wrong-password rejection and credential recovery.

These are release gates alongside existing invariants, not evidence of zero possible bugs.
