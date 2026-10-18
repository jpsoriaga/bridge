import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMPOSER_WARN_CHARS,
  FILE_ERROR_LABELS,
  FILE_ERROR_MESSAGES,
  type FileErrorCode,
  type ListResult,
  type ProjectInfo,
  type TreeEntry,
  type TreeResult
} from '@bridge/shared';
import { MAX_FILES_PER_SEND, type RequestOutcome, type SendFilesResult } from '../messages';
import { formatCount, panelWindowId, request, sessionErrorText } from './request';

/** Marker, fence and blank lines around each file in `@@CONTEXT` format. */
const PER_FILE_OVERHEAD = 40;
const FILTER_LIMIT = 200;

const depthOf = (path: string) => path.split('/').length - 1;
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Estimated characters for a selection: file sizes plus the context format around them. */
export function estimateChars(sizes: ReadonlyMap<string, number>, selected: ReadonlySet<string>) {
  let total = 0;
  for (const path of selected) total += (sizes.get(path) ?? 0) + path.length + PER_FILE_OVERHEAD;
  return total;
}

type Folder =
  { status: 'loading' } | { status: 'ok'; result: ListResult } | { status: 'error'; text: string };

const errorText = (outcome: Exclude<RequestOutcome<unknown>, { ok: true }>) =>
  outcome.error.code in FILE_ERROR_MESSAGES
    ? FILE_ERROR_MESSAGES[outcome.error.code as FileErrorCode]
    : 'Couldn’t list this folder. Check the Bridge app is connected.';

const NO_FOLDERS: ReadonlyMap<string, Folder> = new Map();

/**
 * Folders, loaded one at a time as they're opened, so a 50,000-file project lists as
 * quickly as a small one. Everything is kept per `key` (project and version): a new key
 * starts empty.
 */
function useFolders(key: string) {
  const [state, setState] = useState<{ key: string; folders: ReadonlyMap<string, Folder> }>({
    key,
    folders: NO_FOLDERS
  });
  const cache = useRef<{ key: string; dirs: Map<string, Promise<TreeEntry[]>> }>({
    key,
    dirs: new Map()
  });
  const folders = state.key === key ? state.folders : NO_FOLDERS;

  /** One folder's entries, fetched once per key. */
  const load = useCallback(
    (dir: string): Promise<TreeEntry[]> => {
      if (cache.current.key !== key) cache.current = { key, dirs: new Map() };
      const cached = cache.current.dirs.get(dir);
      if (cached) return cached;
      const put = (folder: Folder) =>
        setState((current) => ({
          key,
          folders: new Map(current.key === key ? current.folders : []).set(dir, folder)
        }));
      put({ status: 'loading' });
      const promise = request<RequestOutcome<ListResult>>({ type: 'get-list', dir })
        .then((outcome) => {
          put(
            outcome.ok
              ? { status: 'ok', result: outcome.result }
              : { status: 'error', text: errorText(outcome) }
          );
          return outcome.ok ? outcome.result.entries : [];
        })
        .catch(() => {
          put({ status: 'error', text: 'Couldn’t list this folder.' });
          return [];
        });
      cache.current.dirs.set(dir, promise);
      return promise;
    },
    [key]
  );

  return { folders, load };
}

/** The whole tree (capped by the app), fetched only once someone filters. */
function useFullTree(enabled: boolean, key: string) {
  const [state, setState] = useState<{ key: string; tree: TreeResult } | null>(null);
  const tree = state?.key === key ? state.tree : null;
  useEffect(() => {
    if (!enabled || tree) return;
    let live = true;
    void request<RequestOutcome<TreeResult>>({ type: 'get-tree' })
      .then((outcome) => live && outcome.ok && setState({ key, tree: outcome.result }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, tree, key]);
  return tree;
}

/** A tree of the project with checkboxes. Inserts the chosen files into the composer. */
export function SendFiles({ project, version }: { project: ProjectInfo; version: number }) {
  const key = `${project.path}\u0000${version}`;
  const { folders, load } = useFolders(key);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; tone?: 'danger' } | null>(null);
  const query = filter.trim().toLowerCase();
  const fullTree = useFullTree(query !== '', key);

  useEffect(() => {
    void load('');
  }, [load]);

  // Every file size seen so far, for the budget meter.
  const sizes = useMemo(() => {
    const map = new Map<string, number>();
    for (const folder of folders.values()) {
      if (folder.status !== 'ok') continue;
      for (const entry of folder.result.entries)
        if (entry.type === 'file') map.set(entry.path, entry.size);
    }
    for (const entry of fullTree?.entries ?? [])
      if (entry.type === 'file') map.set(entry.path, entry.size);
    return map;
  }, [folders, fullTree]);

  /** Rows in tree order: each open folder's entries right after it. */
  const rows = useMemo(() => {
    if (query) {
      return (fullTree?.entries ?? [])
        .filter((e) => e.type === 'file' && !e.collapsed && e.path.toLowerCase().includes(query))
        .slice(0, FILTER_LIMIT);
    }
    const out: TreeEntry[] = [];
    const walk = (dir: string) => {
      const folder = folders.get(dir);
      if (folder?.status !== 'ok') return;
      for (const entry of folder.result.entries) {
        out.push(entry);
        if (entry.type === 'dir' && !entry.collapsed && open.has(entry.path)) walk(entry.path);
      }
    };
    walk('');
    return out;
  }, [folders, fullTree, open, query]);

  const chars = estimateChars(sizes, selected);
  const over = chars > COMPOSER_WARN_CHARS;
  const tooMany = selected.size > MAX_FILES_PER_SEND;
  const root = folders.get('');

  const toggleOpen = (dir: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void load(dir);
      }
      return next;
    });
  };

  /** Every file under a folder, loading folders as needed, stopping past the send limit. */
  const filesUnder = async (dir: string): Promise<string[]> => {
    const found: string[] = [];
    const queue = [dir];
    while (queue.length > 0 && found.length <= MAX_FILES_PER_SEND) {
      for (const entry of await load(queue.shift()!)) {
        if (entry.collapsed) continue;
        if (entry.type === 'file') found.push(entry.path);
        else queue.push(entry.path);
      }
    }
    return found;
  };

  const setMany = (paths: string[], on: boolean) => {
    setResult(null);
    setSelected((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (on) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  };

  const pickFolder = (dir: string, on: boolean) => {
    if (!on) {
      setMany(
        [...selected].filter((p) => p.startsWith(`${dir}/`)),
        false
      );
      return;
    }
    setPicking(dir);
    void filesUnder(dir)
      .then((paths) => setMany(paths, true))
      .finally(() => setPicking(null));
  };

  const send = () => {
    setBusy(true);
    setResult(null);
    void panelWindowId()
      .then((windowId) =>
        request<SendFilesResult>({ type: 'send-files', paths: [...selected], windowId })
      )
      .then((outcome) => {
        if (!outcome.ok) {
          setResult({ text: sessionErrorText(outcome.error), tone: 'danger' });
          return;
        }
        const refused = outcome.refused
          .map(({ path, code }) => `${path} (${FILE_ERROR_LABELS[code]})`)
          .join(', ');
        if (outcome.sent.length === 0) {
          setResult({ text: `Nothing sent. Refused: ${refused}.`, tone: 'danger' });
          return;
        }
        setResult({
          text: `Added ${outcome.sent.length} ${outcome.sent.length === 1 ? 'file' : 'files'} to the message box. Review it and press send.${refused ? ` Not sent: ${refused}.` : ''}`
        });
        setSelected(new Set());
      })
      .catch(() => setResult({ text: sessionErrorText('failed'), tone: 'danger' }))
      .finally(() => setBusy(false));
  };

  return (
    <section aria-labelledby="send-files-label">
      <div className="label-row">
        <p className="label" id="send-files-label">
          Send files
        </p>
        {selected.size > 0 && (
          <button type="button" className="link-button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        )}
      </div>
      {root?.status === 'error' && (
        <p className="error-text" role="alert">
          {root.text}
        </p>
      )}
      {(!root || root.status === 'loading') && (
        <div className="skeleton-group" aria-busy="true" aria-label="Loading project files">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton short" />
        </div>
      )}
      {root?.status === 'ok' && (
        <>
          <input
            className="input tree-filter mono"
            type="search"
            placeholder="Filter files"
            aria-label="Filter files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {root.result.entries.length === 0 ? (
            <p className="hint">This project has no files Bridge can send.</p>
          ) : (
            <ul className="tree" aria-label="Project files">
              {query && !fullTree && <li className="hint tree-note">Searching…</li>}
              {query && fullTree && rows.length === 0 && (
                <li className="hint tree-note">No files match “{filter.trim()}”.</li>
              )}
              {rows.map((entry) => {
                const isDir = entry.type === 'dir';
                const depth = query ? 0 : depthOf(entry.path);
                const expanded = open.has(entry.path);
                const folder = folders.get(entry.path);
                const inside = isDir
                  ? [...selected].filter((p) => p.startsWith(`${entry.path}/`)).length
                  : 0;
                const checked = isDir
                  ? inside > 0 && picking !== entry.path
                  : selected.has(entry.path);
                return (
                  <li
                    key={entry.path}
                    className="tree-row"
                    style={{ paddingInlineStart: depth * 16 }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Send ${entry.path}${isDir ? ' and everything in it' : ''}`}
                      checked={checked}
                      disabled={entry.collapsed === true || picking !== null}
                      onChange={(e) =>
                        isDir
                          ? pickFolder(entry.path, e.target.checked)
                          : setMany([entry.path], e.target.checked)
                      }
                    />
                    {isDir && !entry.collapsed ? (
                      <button
                        type="button"
                        className="tree-folder"
                        aria-expanded={expanded}
                        onClick={() => toggleOpen(entry.path)}
                      >
                        {nameOf(entry.path)}/
                        {expanded && folder?.status === 'loading' && (
                          <span className="tree-size"> Loading…</span>
                        )}
                      </button>
                    ) : (
                      <span className="tree-name" title={entry.path}>
                        {query ? entry.path : nameOf(entry.path)}
                        {isDir ? '/' : ''}
                      </span>
                    )}
                    {!isDir && <span className="tree-size">{formatCount(entry.size)}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {query && fullTree?.truncated && (
            <p className="hint">
              The project is large, so the filter searches only the first part of it. Open folders
              to see everything.
            </p>
          )}
          {[...folders.values()].some((f) => f.status === 'ok' && f.result.truncated) && (
            <p className="hint">A folder has too many entries to list them all.</p>
          )}
          <div className="meter" data-tone={over ? 'warning' : undefined}>
            <div className="meter-track">
              <div
                className="meter-fill"
                style={{ width: `${Math.min(100, (chars / COMPOSER_WARN_CHARS) * 100)}%` }}
              />
            </div>
            <p className="hint">
              {selected.size} {selected.size === 1 ? 'file' : 'files'} · about {formatCount(chars)}{' '}
              of {formatCount(COMPOSER_WARN_CHARS)} characters
            </p>
            {over && (
              <p className="hint" data-tone="warning">
                Over {formatCount(COMPOSER_WARN_CHARS)} characters, the chat may turn this into an
                attachment or cut it off.
              </p>
            )}
            {tooMany && (
              <p className="error-text">Pick at most {MAX_FILES_PER_SEND} files at a time.</p>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary btn-lg action"
            disabled={busy || selected.size === 0 || tooMany}
            onClick={send}
          >
            {busy
              ? 'Adding…'
              : selected.size === 0
                ? 'Insert files'
                : `Insert ${selected.size} ${selected.size === 1 ? 'file' : 'files'}`}
          </button>
          {result && (
            <p className={result.tone ? 'error-text' : 'hint'} role="status">
              {result.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
