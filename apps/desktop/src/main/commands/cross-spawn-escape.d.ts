// cross-spawn's own escaping for cmd.exe, which `CommandRunner` relies on for `.cmd` shims
// on Windows. Imported only by tests, to pin down what it does. Not in @types/cross-spawn.
declare module 'cross-spawn/lib/util/escape' {
  export function argument(arg: string, doubleEscapeMetaChars?: boolean): string;
  export function command(arg: string): string;
}
