import { useEffect, useMemo, useRef, useState } from 'react';
import { diffFile, FILE_ERROR_LABELS, formatArgv, type FileDiff } from '@bridge/shared';
import type { ActivityEntry, OpDetail, RunDetail, UndoOutcome } from '../../preload/api';
import {
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KINDS,
  describeEntry,
  ERROR_TEXT,
  kindsOf,
  undoError,
  type ActivityKind
} from './errors';
import { formatTime } from './hooks';
import { EntryMark, EntryMeta, resultOf } from './EntryMark';
import { Icon } from './Icon';

/** Diff rows rendered before "Show all". */
const DIFF_LIMIT = 400;

/** Activity rows, with each Full auto run's rows gathered under its newest one. */
export type ActivityItem =
  | { kind: 'row'; entry: ActivityEntry }
  | { kind: 'loop'; loopId: string; entries: ActivityEntry[] };

export function groupActivity(entries: readonly ActivityEntry[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const groups = new Map<string, Extract<ActivityItem, { kind: 'loop' }>>();
  for (const entry of entries) {
    if (!entry.loopId) {
      items.push({ kind: 'row', entry });
      continue;
    }
    let group = groups.get(entry.loopId);
    if (!group) {
      group = { kind: 'loop', loopId: entry.loopId, entries: [] };
      groups.set(entry.loopId, group);
      items.push(group);
    }
    group.entries.push(entry);
  }
  return items;
}

/** The rows that match the chosen kinds (none chosen: all) and the search text. */
export function filterActivity(
  entries: readonly ActivityEntry[],
  kinds: ReadonlySet<ActivityKind>,
  query: string
): ActivityEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (kinds.size > 0 && !kindsOf(entry).some((k) => kinds.has(k))) return false;
    if (!q) return true;
    return (
      entry.path.toLowerCase().includes(q) ||
      (entry.from?.toLowerCase().includes(q) ?? false) ||
      (entry.text?.toLowerCase().includes(q) ?? false)
    );
  });
}

const canUndo = (entry: ActivityEntry) => entry.opId !== undefined && !entry.undone;

function Row({ entry, onOpen }: { entry: ActivityEntry; onOpen: (entry: ActivityEntry) => void }) {
  const description = describeEntry(entry);
  const { meta } = description;
  const title = entry.kind === 'loop' ? (entry.text ?? '') : entry.path || '(no path)';
  const openable = entry.kind !== 'loop';
  const body = (
    <>
      <EntryMark description={description} />
      <span className="activity-text">
        <span className={entry.kind === 'loop' ? 'activity-note' : 'activity-path'} title={title}>
          {title}
        </span>
        <span className="activity-meta">
          <EntryMeta description={description} time={formatTime(entry.time)} />
        </span>
      </span>
    </>
  );
  return (
    <li
      className="activity-row"
      data-undone={entry.undone === true}
      data-result={resultOf(entry, description)}
      data-entry={entry.id}
    >
      {openable ? (
        <button
          type="button"
          className="activity-open"
          aria-label={`${title}, ${meta}. Show details`}
          onClick={() => onOpen(entry)}
        >
          {body}
          <Icon name="chevron" className="icon icon-sm activity-chevron" />
        </button>
      ) : (
        <span className="activity-static">{body}</span>
      )}
    </li>
  );
}

/** Before and after as diff rows, or a note when there's nothing to show. */
function DiffBody({ detail }: { detail: OpDetail }) {
  const [all, setAll] = useState(false);
  const diff: FileDiff | null = useMemo(() => {
    if (detail.unavailable || detail.kind === 'rename') return null;
    return diffFile(detail.before, detail.after ?? '');
  }, [detail]);

  if (detail.unavailable) {
    return (
      <p className="empty">
        {detail.unavailable === 'binary'
          ? 'This file isn’t text, so there’s no diff to show.'
          : detail.unavailable === 'too-large'
            ? 'This file is too large to show a diff for.'
            : 'The backup for this change is gone (or it’s from before Bridge kept one), so there’s no diff to show.'}
      </p>
    );
  }
  if (detail.kind === 'rename') {
    return <p className="empty">Moved without changing its content.</p>;
  }
  if (!diff) return null;
  // A delete shows the whole file as removed.
  const lines =
    detail.kind === 'delete'
      ? (detail.before ?? '')
          .replace(/\n$/, '')
          .split('\n')
          .map((text) => ({ kind: 'del' as const, text }))
      : diff.lines;
  if (lines.length === 0) return <p className="empty">No changes.</p>;
  const shown = all ? lines : lines.slice(0, DIFF_LIMIT);
  const prefix = { add: '+ ', del: '- ', ctx: '  ', hunk: '' } as const;
  return (
    <div className="diff" role="region" aria-label="Changes" tabIndex={0}>
      {shown.map((line, i) => (
        <div key={i} className="diff-row" data-kind={line.kind}>
          {prefix[line.kind]}
          {line.text}
        </div>
      ))}
      {shown.length < lines.length && (
        <button type="button" className="diff-more" onClick={() => setAll(true)}>
          Show all {lines.length.toLocaleString('en-US')} lines
        </button>
      )}
    </div>
  );
}

type Loaded<T> = { status: 'loading' } | { status: 'ok'; value: T | null };

/** One row in full: the diff of a change, or a command's output, with Undo. */
function Detail({ entry, onBack }: { entry: ActivityEntry; onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [op, setOp] = useState<Loaded<OpDetail>>({ status: 'loading' });
  const [run, setRun] = useState<Loaded<RunDetail>>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const description = describeEntry(entry);

  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    let live = true;
    if (entry.opId) {
      void window.bridge
        .getOpDetail(entry.opId)
        .then((value) => live && setOp({ status: 'ok', value }));
    }
    if (entry.runId) {
      void window.bridge
        .getRunDetail(entry.runId)
        .then((value) => live && setRun({ status: 'ok', value }));
    }
    return () => {
      live = false;
    };
  }, [entry.opId, entry.runId, entry.undone]);

  const undo = () => {
    if (!entry.opId) return;
    setBusy(true);
    setError(null);
    void window.bridge
      .undo(entry.opId)
      .then((outcome: UndoOutcome) => setError(undoError(outcome)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="detail" aria-labelledby="detail-title">
      <button type="button" className="link-button back" onClick={onBack}>
        <Icon name="back" className="icon icon-sm" />
        Back to activity
      </button>
      <div className="section-head">
        <h2 className="detail-title mono" id="detail-title" ref={heading} tabIndex={-1}>
          {entry.kind === 'rename'
            ? `${entry.from ?? '?'} → ${entry.path}`
            : entry.path || '(no path)'}
        </h2>
        {canUndo(entry) && (
          <button type="button" className="btn" disabled={busy} onClick={undo}>
            {busy ? 'Undoing…' : 'Undo'}
          </button>
        )}
      </div>
      <p className="status detail-meta">
        <EntryMark description={description} />
        <span>
          <EntryMeta description={description} time={new Date(entry.time).toLocaleString()} />
        </span>
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {entry.code && <p className="notice">{ERROR_TEXT[entry.code]}</p>}
      {entry.opId &&
        (op.status === 'loading' ? (
          <div className="skeleton-group" aria-busy="true" aria-label="Loading the diff">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton short" />
          </div>
        ) : op.value ? (
          <DiffBody detail={op.value} />
        ) : (
          <p className="empty">Bridge no longer has a record of this change.</p>
        ))}
      {entry.runId &&
        (run.status === 'loading' ? (
          <div className="skeleton-group" aria-busy="true" aria-label="Loading the output">
            <span className="skeleton" />
            <span className="skeleton short" />
          </div>
        ) : run.value ? (
          <>
            <p className="value mono command-line">$ {formatArgv(run.value.argv)}</p>
            <pre className="command-output command-output-full" tabIndex={0} aria-label="Output">
              {run.value.output || '(no output)'}
            </pre>
            {run.value.truncated && (
              <p className="hint">
                The middle of a long output was cut. The start and end are here.
              </p>
            )}
          </>
        ) : (
          <p className="empty">The full output is kept only until Bridge quits.</p>
        ))}
      {entry.kind === 'run' && !entry.runId && (
        <p className="empty">The full output is kept only until Bridge quits.</p>
      )}
      {entry.op === 'run' && entry.code && entry.kind === 'failed' && (
        <p className="hint">The command didn’t run. {FILE_ERROR_LABELS[entry.code]}.</p>
      )}
    </section>
  );
}

/**
 * Everything Bridge did or refused in this project: filter by kind, search by path, Full
 * auto runs grouped, and a detail view (diff or output) with Undo.
 */
export function ActivityView({
  entries,
  hasProject
}: {
  entries: ActivityEntry[] | null;
  hasProject: boolean;
}) {
  const [kinds, setKinds] = useState<Set<ActivityKind>>(new Set());
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnTo = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const open = openId ? (entries ?? []).find((e) => e.id === openId) : undefined;
  const shown = useMemo(() => filterActivity(entries ?? [], kinds, query), [entries, kinds, query]);
  const canUndoLast = (entries ?? []).some(canUndo);

  // Back from the detail view: focus returns to the row it came from.
  useEffect(() => {
    if (open || !returnTo.current) return;
    const id = returnTo.current;
    returnTo.current = null;
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-entry]') ?? [];
    [...rows]
      .find((row) => row.dataset.entry === id)
      ?.querySelector('button')
      ?.focus();
  }, [open]);

  if (open) {
    return <Detail key={open.id} entry={open} onBack={() => setOpenId(null)} />;
  }

  const toggle = (kind: ActivityKind) =>
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  const show = (entry: ActivityEntry) => {
    returnTo.current = entry.id;
    setOpenId(entry.id);
  };
  const undoLast = () => {
    setBusy(true);
    setError(null);
    void window.bridge
      .undoLast()
      .then((outcome) => setError(undoError(outcome)))
      .finally(() => setBusy(false));
  };

  return (
    <section aria-labelledby="activity-title">
      <div className="section-head">
        <h2 className="section-title" id="activity-title">
          Activity
        </h2>
        <button type="button" className="btn" disabled={busy || !canUndoLast} onClick={undoLast}>
          Undo last
        </button>
      </div>
      <div className="toolbar">
        <label className="search">
          <Icon name="search" className="icon icon-sm" />
          <span className="sr-only">Search by path</span>
          <input
            className="input mono"
            type="search"
            placeholder="Search by path"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="chips" role="group" aria-label="Show only">
          {ACTIVITY_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="chip"
              aria-pressed={kinds.has(kind)}
              onClick={() => toggle(kind)}
            >
              {ACTIVITY_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {entries === null ? (
        <div className="skeleton-group" aria-busy="true" aria-label="Loading activity">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton short" />
        </div>
      ) : !hasProject ? (
        <p className="empty">Open a project to see its activity.</p>
      ) : entries.length === 0 ? (
        <p className="empty">
          Nothing yet. Files the chat writes, deletes or renames, commands it runs, and anything
          Bridge blocks show up here.
        </p>
      ) : shown.length === 0 ? (
        <p className="empty">
          Nothing matches.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setKinds(new Set());
              setQuery('');
            }}
          >
            Clear filters
          </button>
        </p>
      ) : (
        <div ref={list}>
          <ul className="activity" aria-label="Activity">
            {groupActivity(shown).map((item) =>
              item.kind === 'row' ? (
                <Row key={item.entry.id} entry={item.entry} onOpen={show} />
              ) : (
                <li key={item.loopId} className="activity-group">
                  <p className="activity-group-head">
                    Full auto run ·{' '}
                    {
                      item.entries.filter((e) => e.kind === 'loop' && e.text?.startsWith('Sent'))
                        .length
                    }{' '}
                    messages sent
                  </p>
                  <ul className="activity">
                    {item.entries.map((entry) => (
                      <Row key={entry.id} entry={entry} onOpen={show} />
                    ))}
                  </ul>
                </li>
              )
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
