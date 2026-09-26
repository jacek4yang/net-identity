# Contributing

Thanks for considering a contribution. `net-identity` is a small, deliberately dependency
free Firefox extension; the goal is that a newcomer (human or coding agent) can read the
whole thing in an afternoon.

## Getting set up

```bash
git clone https://github.com/jacek4yang/net-identity
cd net-identity
npm install          # Node.js >= 22
npm run check        # must pass before you push
npm run dev          # builds dist/ and starts Firefox with the extension
```

## Ground rules

- **Firefox only.** No cross-browser abstractions, no `webextension-polyfill`.
- **No new runtime dependencies.** Dev tooling additions need a justification in the PR.
- **No frameworks in the UI.** Plain HTML/CSS/TypeScript.
- **Validate at every boundary.** New data from storage, messages, the network or the
  page needs a parser returning `Result<T>` — not a cast.
- **Never persist or log a credential.** Passwords belong to `storage.session` only.
- **Tests accompany behaviour.** A bug fix should come with a test that fails without it.

## Workflow

`main` is protected: changes arrive through pull requests with linear history and the
required `quality` CI check. Direct pushes to `main` are rejected.

```bash
git switch -c fix/short-description
# ... make the change ...
npm run check
git commit -m "fix: describe the change"
git push -u origin HEAD
gh pr create --fill
```

## Commit messages

Conventional commits are expected:

```
feat: add per-profile WebRTC policy override
fix: keep proxy credentials out of the popup response
test: cover stale page-shim detection
docs: explain why proxyDNS is SOCKS-only
chore(deps): bump typescript
```

## What CI runs

1. `prettier --check .`
2. `eslint .` (type-aware, with `no-explicit-any`, `no-non-null-assertion` and
   `consistent-type-imports` as errors)
3. `tsc --noEmit`
4. `vitest run`
5. `node scripts/build.mjs` (verifies the manifest references only emitted files)
6. `node scripts/lint-extension.mjs` — every error **and** any unexpected warning fails;
   the allowed warning about Android `data_collection_permissions` versus the desktop-only
   floor are documented in `scripts/lint-extension.mjs`
7. `npm run package`, then inspecting the zip contents

## Code style notes

- Prefer small pure functions over classes; the only class is the activation controller,
  because it owns a lifecycle.
- Avoid `any`, non-null assertions and silent `catch` blocks. `describeError()` exists so
  error handling never leaks a credential.
- Keep `src/background/index.ts` wiring-only.
- Comments should explain _why_ something Firefox-specific is done the way it is
  (see `AGENTS.md` §4 for the ones that must not be "simplified").

## Security

Please read [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY.md`](docs/SECURITY.md) before
touching credentials, the proxy decision logic, the page shims or the manifest
permissions. Report vulnerabilities privately rather than in a public issue.

## Licence

By contributing you agree that your contributions are licensed under the MIT licence.
