Bridge extension
================

Version {version}.

This is the Bridge browser extension for Chrome, Edge and Brave. It lets the chat on
chatgpt.com suggest changes to a project on your computer, shown as cards you can apply
or undo.

It needs the Bridge desktop app: the extension only talks to that app, on your own
computer. Download the app for your system from the release page:

  https://github.com/jpsoriaga/bridge/releases/tag/{tag}

Add the extension
-----------------

1. Keep this folder (the one with manifest.json and this file) somewhere you won't
   delete or move it. Your browser loads the extension from here every time it starts.
2. Open chrome://extensions (or edge://extensions, brave://extensions).
3. Turn on Developer mode.
4. Click Load unpacked and choose this folder.
5. Pin the Bridge icon: puzzle-piece icon, then the pin next to Bridge.

Then pair it: in the Bridge app click Pair extension, click the Bridge icon to open the
side panel, type the code, and check the fingerprints match in both before you confirm.

The full install steps are in the release's Bridge-{version}-INSTALL.md.
