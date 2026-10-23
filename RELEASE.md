# Releasing Bridge

A release is one version number for the desktop app, the extension and `@bridge/shared`, cut from `main` by pushing a `v*` tag. GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) runs every check, builds the installers and the extension zip, verifies and smoke-tests each app, and leaves everything in a **draft** release. Nothing is published until you publish it. Before tagging, run the same workflow by hand as a [dry run](#dry-run).

## What the workflow does

1. Runs the full CI suite (format, lint, typecheck, build, tests with coverage, `pnpm audit`, the e2e scripts) by calling [`ci.yml`](.github/workflows/ci.yml). It gets no secrets.
2. Checks every package has the tag's version (`pnpm version:check vX.Y.Z`) and that `CHANGELOG.md` has a section for it.
3. Builds on `macos-latest` (dmg and zip, arm64 and x64), `windows-latest` (NSIS installer, x64) and `ubuntu-latest` (AppImage, x64). Signing secrets reach only the packaging step for their platform.
4. For each app: `verify:fuses`, `check:package` (fuses again, and app.asar holds only the built app and its production dependencies), and a smoke test (launch with a fresh temp userData, window loads, `/health` answers on `127.0.0.1`, quit, wait until every process is gone and the port is free). The window gets 90s to load, or 120s for the x64 mac build, which runs under Rosetta on the arm64 runner; each app's run stops after 3 minutes at most.
5. Builds the extension zips (`pnpm build:extension:release`): `bridge-extension-X.Y.Z.zip` for the store and `bridge-extension-X.Y.Z-unpacked.zip` for Load unpacked.
6. Creates a draft release named "Bridge X.Y.Z" with every installer, `latest*.yml` (for the app's update check), both extension zips, `SHA256SUMS.txt`, and that version's `CHANGELOG.md` section as the notes.

## Dry run

Run by hand, the workflow is a dry run for the version in the packages: steps 1 to 5 exactly as above (the version and changelog checks use `v` + that version), every installer and zip uploaded as a run artifact, and instead of step 6 a summary of what the draft would hold (files and checksums, `gh` flags, notes). It never creates a release, and its last job has no write permission. Run it after pushing the version bump and before tagging:

```bash
gh workflow run release.yml --ref main
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

(Or Actions → Release → **Run workflow** on `main`.) Green means the tag push will build the same thing; red costs nothing to fix, since no tag exists yet. The run's summary page shows the would-be notes, and its artifacts hold the installers if you want to try one first.

## Cutting a release

```bash
git switch main && git pull

# 1. Bump the version everywhere (root, desktop, extension, shared).
pnpm version:set 1.1.0

# 2. Move the changelog's "Unreleased" notes under a new heading:
#      ## [1.1.0] - YYYY-MM-DD
#    and add its compare link at the bottom.
$EDITOR CHANGELOG.md

# 3. Check locally (same as CI).
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage
pnpm build:extension:release

# 4. Commit and push, without a tag yet.
git commit -am "chore: release 1.1.0"
git push origin main

# 5. Dry run (see "Dry run"); wait for it to go green.
gh workflow run release.yml --ref main

# 6. Tag and push the tag.
git tag -a v1.1.0 -m "Bridge 1.1.0"
git push origin v1.1.0
```

Then:

7. **Watch the run** under Actions → Release. A red check means no release was created; fix, delete the tag (`git push --delete origin v1.1.0 && git tag -d v1.1.0`), and tag again.
8. **Check the draft** under Releases: every file is there (two dmgs, two mac zips, the Windows setup exe, the AppImage, `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, both extension zips, `SHA256SUMS.txt`), the notes read right, and the logs say whether each build was signed. Download one installer and try it.
9. **Publish** the draft. From then on, apps with "Check for updates" see the new version and link to it.
10. **Upload the extension** to the Chrome Web Store (below).

## Beta release

A beta is a version like `1.2.0-beta.1`, for testers. The same tag-driven workflow builds it, with three differences, all decided from the tag (`scripts/release-flags.mjs`, `scripts/release-extension.mjs`):

- The draft is a **pre-release** and is **never marked Latest** (`--prerelease --latest=false`), so the README's "latest release" links and the Stable update channel never land on it.
- Only the **Load unpacked** extension zip (`bridge-extension-X.Y.Z-beta.N-unpacked.zip`), which keeps the fixed ID the app accepts. No store zip, and nothing goes to the Chrome Web Store.
- The notes start with a line pointing testers at [BETA.md](BETA.md).

Apps report the full version (`1.2.0-beta.1` in Settings → About). The extension's manifest gets `version` `1.2.0` (Chrome takes numbers only) and `version_name` `1.2.0-beta.1`, which Chrome and the side panel show. Beta builds start on the **Beta** update channel, so on Windows and Linux **Check for updates** finds newer betas and the final release; unsigned macOS builds don't check at all.

### Cutting a beta

```bash
git switch main && git pull

# 1. Bump to the beta (the next one is -beta.2, and so on; the final release drops the suffix).
pnpm version:set 1.2.0-beta.1

# 2. Move the changelog's "Unreleased" notes under a new heading:
#      ## [1.2.0-beta.1] - YYYY-MM-DD
#    and add its compare link at the bottom. (For beta.2, a new section with what changed
#    since beta.1. The final 1.2.0 section sums up everything since 1.1.0.)
$EDITOR CHANGELOG.md

# 3. Check locally (same as CI), and build the beta's extension zip.
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage
pnpm build:extension:release      # only release/bridge-extension-1.2.0-beta.1-unpacked.zip

# 4. Commit and push, without a tag yet.
git commit -am "chore: release 1.2.0-beta.1"
git push origin main

# 5. Dry run (see "Dry run"); wait for it to go green.
gh workflow run release.yml --ref main

# 6. Tag and push the tag.
git tag -a v1.2.0-beta.1 -m "Bridge 1.2.0-beta.1"
git push origin v1.2.0-beta.1
```

Then:

7. **Watch the run** under Actions → Release (as for a release; to redo it, delete the tag and tag again).
8. **Check the draft** under Releases: it says **Pre-release**, the notes start with "Beta for testers", and the files are the two dmgs, two mac zips, the Windows setup exe, the AppImage, `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `bridge-extension-1.2.0-beta.1-unpacked.zip` (and no store zip) and `SHA256SUMS.txt`. Download an installer and the extension zip and go through BETA.md's install steps once yourself.
9. **Publish** the draft, keeping **Set as a pre-release** ticked and **Set as the latest release** unticked.
10. **Share** with testers: the release page link (`https://github.com/jpsoriaga/bridge/releases/tag/v1.2.0-beta.1`) and BETA.md (`https://github.com/jpsoriaga/bridge/blob/v1.2.0-beta.1/BETA.md`). Say which file to download for their computer, that the warnings on first open are expected, and that diagnostics can come back to you directly if they have no GitHub account. Reports arrive as issues labelled `beta`.

Never upload a beta to the Chrome Web Store.

## Chrome Web Store

The store build is `release/bridge-extension-X.Y.Z.zip` (also on the release). It's minified, has no source maps and no manifest `key` (the store assigns the ID and refuses a `key`), and holds only the build's files. Its sibling `bridge-extension-X.Y.Z-unpacked.zip` is the same build with the `key`, for people who load it unpacked; never upload that one.

Listing text, permission justifications, data-use answers and images are in [`store/`](store/README.md).

### Every release

1. Open the [developer dashboard](https://chrome.google.com/webstore/devconsole), choose Bridge, **Package → Upload new package**, and pick the zip.
2. Check the listing still matches `store/` (update the text or screenshots there first if anything changed).
3. **Submit for review.** Reviews take from hours to a few days. Publish when approved (or let it publish automatically).

### First upload, once

The unpacked dev build gets its fixed ID from the manifest `key` (`golkpkmancgpgkpfjggoimedcogghhip`). The store will assign a different one. To have both builds share the store's ID, so the app accepts either and you never pair twice:

1. Register a [Chrome Web Store developer account](https://chrome.google.com/webstore/devconsole/register) (one-time fee).
2. **Add new item** and upload the zip. Fill in the listing from `store/`, but **don't submit yet** (save it as a draft).
3. On the item's **Package** page, click **View public key**. Copy the key (the base64 between the `BEGIN`/`END` lines, on one line).
4. In `apps/extension/manifest.config.ts`, replace `EXTENSION_PUBLIC_KEY` with it.
5. Run `pnpm test`: `manifest.test.ts` fails and prints the ID that key produces. Put that ID in `BRIDGE_EXTENSION_ID` **and** `STORE_EXTENSION_ID` in `packages/shared/src/protocol.ts`. (The ID is also on the dashboard.)
6. `pnpm test` again, then commit ("chore: use the store's extension ID"). The desktop app now accepts that ID (`allowedExtensionIds` in `apps/desktop/src/main/server/config.ts`).
7. Release a new version with that change (the steps above), so the app that knows the new ID is out before the extension.
8. Back in the dashboard, upload that version's zip and **submit for review**.

Anyone who loaded the old unpacked build needs to reload it from the new `dist` and pair again (its ID changed). If you'd rather keep the old dev ID too, leave `BRIDGE_EXTENSION_ID` as it was and set only `STORE_EXTENSION_ID`: the app then accepts both, and the two builds have different IDs.

## Signing

Builds without signing secrets are unsigned, and say so in the log (`⚠️ Packaging for mac UNSIGNED`). README.md explains how users open them. To sign, add these as **repository secrets** (Settings → Secrets and variables → Actions → New repository secret). The release workflow passes them only to the packaging step of their platform, never to CI or pull requests. Set all of a platform's secrets or none: a partial set fails the build rather than shipping unsigned by mistake.

### macOS (Developer ID and notarization)

Needs an [Apple Developer Program](https://developer.apple.com/programs/) membership.

| Secret             | What it is                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`         | Your **Developer ID Application** certificate and private key, exported from Keychain Access as a `.p12`, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | The password you gave the `.p12`                                                                                                                         |
| `APPLE_API_KEY`    | An App Store Connect API key (Users and Access → Integrations → App Store Connect API, role Developer): the **contents** of the `AuthKey_XXXX.p8` file   |
| `APPLE_API_KEY_ID` | That key's ID (the `XXXX`)                                                                                                                               |
| `APPLE_API_ISSUER` | The issuer ID shown above the keys list                                                                                                                  |

With them, the macOS build is signed with hardened runtime (entitlements: `allow-jit` only, `apps/desktop/resources/entitlements.mac.plist`), notarized with `notarytool`, and stapled. Update checks are on in signed builds.

### Windows (Authenticode)

| Secret                 | What it is                                                                     |
| ---------------------- | ------------------------------------------------------------------------------ |
| `WIN_CSC_LINK`         | A code signing certificate as a `.pfx`, base64-encoded (`base64 -w0 cert.pfx`) |
| `WIN_CSC_KEY_PASSWORD` | Its password                                                                   |

An OV certificate stops the "unknown publisher" text; SmartScreen's warning fades as the certificate builds reputation (an EV certificate skips that, but usually lives on a hardware token, which this workflow doesn't support).

### Linux

The AppImage isn't signed. `SHA256SUMS.txt` on the release lets users check it.

## Building locally

```bash
pnpm package:mac      # or package:win, package:linux (each on its own OS)
pnpm --filter @bridge/desktop check:package      # fuses and asar contents of everything in dist/
pnpm --filter @bridge/desktop verify:fuses apps/desktop/dist/mac-arm64/Bridge.app
pnpm --filter @bridge/desktop smoke dist/mac-arm64/Bridge.app
pnpm --filter @bridge/desktop smoke dist/mac/Bridge.app      # x64; under Rosetta on Apple silicon
pnpm build:extension:release
```

Output lands in `apps/desktop/dist/` and `release/` (both git-ignored). Set the signing variables in your shell to sign locally; without them the build is unsigned, as in CI. On macOS an unsigned build is ad-hoc signed without hardened runtime, which is what Apple silicon needs to run it at all.
