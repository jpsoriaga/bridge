// What Electron may do on the renderer's behalf: nothing beyond showing the app. Kept to
// structural types so the rules can be tested without Electron.

interface Preventable {
  preventDefault(): void;
}

/** The parts of a `Session` the lock-down uses. */
export interface SessionLike {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
  ): void;
  setPermissionCheckHandler(handler: (...args: unknown[]) => boolean): void;
}

/** The parts of a `WebContents` the lock-down uses. */
export interface ContentsLike {
  on(event: 'will-navigate' | 'will-redirect', listener: (event: Preventable) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: Preventable) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
}

/** Every permission request (camera, notifications, clipboard…) and check is refused. */
export function lockDownSession(session: SessionLike): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

/**
 * No navigation away from the app, no redirects, no new windows and no `<webview>`. An
 * https link a window tries to open goes to the default browser instead.
 */
export function lockDownContents(
  contents: ContentsLike,
  openExternal: (url: string) => void = () => {}
): void {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) openExternal(url);
    return { action: 'deny' };
  });
}
