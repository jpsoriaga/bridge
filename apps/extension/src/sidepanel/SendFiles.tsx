import { useEffect, useMemo, useState } from 'react';
import {
  COMPOSER_WARN_CHARS,
  FILE_ERROR_LABELS,
  type ProjectInfo,
  type TreeEntry,
  type TreeResult
} from '@bridge/shared';
import { MAX_FILES_PER_SEND, type RequestOutcome, type SendFilesResult } from '../messages';
import { formatCount, request, sessionErrorText } from './request';

/** Marker, fence and blank lines around each file in `@@CONTEXT` format. */
const PER_FILE_OVERHEAD = 40;
const FILTER_LIMIT = 200;

const depthOf = (path: string) => path.split('/').length - 1;
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Estimated characters for a selection: file sizes plus the context format around them. */
export function estimateChars(
  entries: readonly TreeEntry[],
  selected: ReadonlySet<string>
): number {
  let total = 0;
  for (const entry of entries) {
    if (selected.has(entry.path)) total += entry.size + entry.path.length + PER_FILE_OVERHEAD;
  }
  return total;
}

/** The project tree, fetched again when the project or `version` changes. */
function useTree(projectPath: string | undefined, version: number) {
  const [tree, setTree] = useState<TreeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void request<RequestOutcome<TreeResult>>({ type: 'get-tree' })
      .then((outcome) => {
        if (!live) return;
        if (outcome.ok) {
          setTree(outcome.result);
          setError(null);
        } else setError(outcome.error.message);
      })
      .catch(() => live && setError('Couldn’t list the project files.'));
    return () => {
      live = false;
    };
  }, [projectPath, version]);
  return { tree, error };
}

/** A tree of the project with checkboxes. Inserts the chosen files into the composer. */
export function SendFiles({ project, version }: { project: ProjectInfo; version: number }) {
  const { tree, error } = useTree(project.path, version);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone?: 'danger' } | null>(null);

  const entries = useMemo(() => tree?.entries ?? [], [tree]);
  const files = useMemo(() => entries.filter((e) => e.type === 'file' && !e.collapsed), [entries]);
  const filesUnder = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const file of files) {
      for (let dir = parentOf(file.path); dir; dir = parentOf(dir)) {
        const list = map.get(dir) ?? [];
        list.push(file.path);
        map.set(dir, list);
      }
    }
    return map;
  }, [files]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (query) {
      return files.filter((f) => f.path.toLowerCase().includes(query)).slice(0, FILTER_LIMIT);
    }
    // A row shows when every folder above it is open.
    return entries.filter((entry) => {
      for (let dir = parentOf(entry.path); dir; dir = parentOf(dir)) {
        if (!open.has(dir)) return false;
      }
      return true;
    });
  }, [entries, files, filter, open]);

  const chars = estimateChars(files, selected);
  const over = chars > COMPOSER_WARN_CHARS;
  const tooMany = selected.size > MAX_FILES_PER_SEND;

  const toggle = (paths: string[], on: boolean) => {
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

  const send = () => {
    setBusy(true);
    setResult(null);
    void request<SendFilesResult>({ type: 'send-files', paths: [...selected] })
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
    <section>
      <div className="label-row">
        <p className="label">Send files</p>
        {selected.size > 0 && (
          <button type="button" className="link-button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      {tree && (
        <>
          <input
            className="input tree-filter mono"
            type="search"
            placeholder="Filter files"
            aria-label="Filter files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="tree" aria-label="Project files">
            {visible.map((entry) => {
              const isDir = entry.type === 'dir';
              const under = isDir ? (filesUnder.get(entry.path) ?? []) : [entry.path];
              const count = under.filter((p) => selected.has(p)).length;
              const checked = under.length > 0 && count === under.length;
              const depth = filter.trim() ? 0 : depthOf(entry.path);
              const expanded = open.has(entry.path);
              return (
                <li
                  key={entry.path}
                  className="tree-row"
                  style={{ paddingInlineStart: depth * 16 }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Send ${entry.path}`}
                    checked={checked}
                    disabled={entry.collapsed === true || under.length === 0}
                    ref={(box) => {
                      if (box) box.indeterminate = count > 0 && !checked;
                    }}
                    onChange={(e) => toggle(under, e.target.checked)}
                  />
                  {isDir && !entry.collapsed ? (
                    <button
                      type="button"
                      className="tree-folder"
                      aria-expanded={expanded}
                      onClick={() =>
                        setOpen((current) => {
                          const next = new Set(current);
                          if (expanded) next.delete(entry.path);
                          else next.add(entry.path);
                          return next;
                        })
                      }
                    >
                      {nameOf(entry.path)}/
                    </button>
                  ) : (
                    <span className="tree-name" title={entry.path}>
                      {filter.trim() ? entry.path : nameOf(entry.path)}
                      {isDir ? '/' : ''}
                    </span>
                  )}
                  {!isDir && <span className="tree-size">{formatCount(entry.size)}</span>}
                </li>
              );
            })}
          </ul>
          {tree.truncated && (
            <p className="hint">The project is large, so Bridge listed only part of it.</p>
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
