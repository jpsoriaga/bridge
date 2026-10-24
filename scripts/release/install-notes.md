<!--
The "How to install" section at the top of every release's notes, and the release's
Bridge-<version>-INSTALL.md. Filled in by scripts/install-notes.mjs (RELEASE.md, "Release notes"):

  {version} {tag} {macArm64} {macX64} {macZipArm64} {macZipX64} {win} {linux} {extension}
  {storeExtension}

are replaced with this version's file names. Blocks between these markers are kept or dropped:

  beta ... /beta       betas only
  stable ... /stable   stable releases only
  full ... /full       INSTALL.md only, not the release notes

Don't use curly braces anywhere else: the tests fail on any left over. This comment is dropped.
-->

## How to install

<!-- full -->

Bridge {version}: install steps for macOS, Windows and Linux.

<!-- /full -->
<!-- beta -->

**This is a beta**, a test version for testers. Try it on a practice folder, not on work you can't afford to lose. The full guide, with what to test and how to report problems: [BETA.md](https://github.com/jpsoriaga/bridge/blob/{tag}/BETA.md).

<!-- /beta -->

Bridge has two parts: the **app** you install on your computer, and the **extension** you add to Chrome, Edge or Brave. You need both.

### 1. Pick your files

| Your computer                        | Download      |
| ------------------------------------ | ------------- |
| Mac with Apple silicon (M1 or later) | `{macArm64}`  |
| Mac with an Intel processor          | `{macX64}`    |
| Windows 10 or 11 (64-bit)            | `{win}`       |
| Linux (64-bit)                       | `{linux}`     |
| **Everyone also needs**              | `{extension}` |

**Which Mac do I have?** Apple menu (top-left corner of the screen) → **About This Mac**. **Chip: Apple M1** (or M2, M3…) means Apple silicon; **Processor: Intel** means Intel.

### 2. Install the app

The app isn't signed yet, so your computer warns you the first time. That's expected.

- **macOS:** open the `.dmg` and drag **Bridge** into **Applications**. The first time, **right-click** Bridge in Applications → **Open** → **Open**. (On macOS 15 and later, if it only offers **Done**: **System Settings → Privacy & Security → Open Anyway**.)
- **Windows:** run the setup `.exe`. If you see **"Windows protected your PC"**, click **More info → Run anyway**. It installs for your user only.
- **Linux:** in a terminal, `chmod +x Bridge-*.AppImage`, then `./Bridge-*.AppImage`.

### 3. Add the extension

1. **Unzip** `{extension}` into a folder you'll keep (your browser loads it from there every time).
2. Go to `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` in it).
5. **Pin** the Bridge icon: puzzle-piece icon → pin next to Bridge. Reload chatgpt.com if it was open.

### 4. Pair them

1. In the app, click **Pair extension**. It shows a 6-digit code.
2. Click the Bridge icon to open the side panel, type the code, click **Pair**.
3. **Check the fingerprints** (like `a1b2 c3d4`) are exactly the same in both. If they are, click **They match** in the app, then in the side panel. If not, click **Cancel** in both and start again.

### You can ignore these files

- `latest.yml`, `latest-mac.yml`, `latest-linux.yml`: for the app's update check.
- The Mac `.zip` files (`{macZipArm64}`, `{macZipX64}`): the same app as the `.dmg`, for the update check.

<!-- stable -->

- `{storeExtension}`: the Chrome Web Store build. Use the `-unpacked` one.

<!-- /stable -->

- `SHA256SUMS.txt`: checksums, if you want to verify your downloads.
- **Source code** (zip and tar.gz): only for building Bridge yourself.

<!-- full -->

## Troubleshooting

**macOS says "Bridge is damaged and can't be opened".** It isn't damaged: macOS says this about unsigned apps from the internet. Open **Terminal** (Applications → Utilities), paste this, press Return, then open Bridge again:

```bash
xattr -dr com.apple.quarantine /Applications/Bridge.app
```

**Linux: nothing happens, or the terminal mentions FUSE or the "SUID sandbox".** Install FUSE (`sudo apt install libfuse2`, or `libfuse2t64` on Ubuntu 24.04). On Ubuntu 24.04 and later, `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` allows Bridge's sandbox until you restart. Don't use `--no-sandbox`.

**Can't pair.**

- The app must be open. The code works once and expires after 2 minutes: click **Pair extension** again for a new one.
- After 5 wrong codes, pairing locks for a while. Wait, then try a fresh code.
- The app and the extension must be the same version (`{version}`). If one is older, both say which one to update.
- If the fingerprints differ twice in a row, stop and report it: something other than your Bridge app answered.

**The extension doesn't show anything on chatgpt.com.**

- Check Bridge is turned on in your browser's extensions page, and reload the chatgpt.com tab.
- Click the Bridge icon: the side panel says whether it's connected and paired.
- If it says "Bridge can't read this page layout", the chat's page changed. Please report it with the diagnostics (side panel → **Copy diagnostics**).
- You loaded the folder that contains `manifest.json`, not a folder above it.

## Uninstall

First click **Unpair** in the app or the side panel. Remove the extension from your browser's extensions page, and delete the folder you unzipped it into. Then:

- **macOS:** quit Bridge, drag it from **Applications** to the Trash, and delete `~/Library/Application Support/Bridge` (Finder → **Go → Go to Folder…**).
- **Windows:** **Settings → Apps → Installed apps → Bridge → Uninstall**, then delete `%APPDATA%\Bridge`.
- **Linux:** delete the `.AppImage` file and `~/.config/Bridge`.

The data folder holds Bridge's settings, its pairing key, backups of files it changed, and its logs.

<!-- /full -->

### More help

<!-- beta -->

- [BETA.md](https://github.com/jpsoriaga/bridge/blob/{tag}/BETA.md): the full install guide, what to test, troubleshooting and uninstalling.

<!-- /beta -->
<!-- stable -->

- [README](https://github.com/jpsoriaga/bridge/blob/{tag}/README.md): the full install guide, how to use Bridge, troubleshooting and uninstalling.

<!-- /stable -->
<!-- full -->

- [Release page](https://github.com/jpsoriaga/bridge/releases/tag/{tag}): every download for this version.

<!-- /full -->

- Something wrong? Open a [Beta bug report](https://github.com/jpsoriaga/bridge/issues/new?template=beta-bug-report.yml), with the diagnostics from the app (**Help → Copy diagnostics**) and the side panel.
