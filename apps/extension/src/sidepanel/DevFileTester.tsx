import { useState, type FormEvent } from 'react';
import type { RequestOutcome, WorkerRequest } from '../messages';

type Op = 'tree' | 'read' | 'write' | 'undo';

/**
 * Dev builds only (`import.meta.env.DEV`): send tree, read, write or undo to the desktop by
 * hand, to try the sandbox. For undo, the text field takes the `opId` a write returned. A write reuses the hash from the last read of the same path, so
 * reading first makes it a modify and skipping the read makes it a create.
 */
export function DevFileTester() {
  const [op, setOp] = useState<Op>('read');
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [lastRead, setLastRead] = useState<{ path: string; hash: string } | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const request: Extract<WorkerRequest, { type: 'dev-file' }>['request'] =
      op === 'tree'
        ? { type: 'tree', payload: {} }
        : op === 'read'
          ? { type: 'read', payload: { path } }
          : op === 'undo'
            ? { type: 'undo', payload: { opId: path } }
            : {
                type: 'write',
                payload:
                  lastRead?.path === path
                    ? { path, content, baseHash: lastRead.hash }
                    : { path, content }
              };
    setBusy(true);
    void chrome.runtime
      .sendMessage<WorkerRequest, RequestOutcome<unknown>>({ type: 'dev-file', request })
      .then((outcome) => {
        if (outcome.ok && op === 'read') {
          const { hash, content: text } = outcome.result as { hash: string; content: string };
          setLastRead({ path, hash });
          setContent(text);
        }
        if (outcome.ok && op === 'write') setLastRead(null);
        const text = JSON.stringify(outcome, null, 2);
        setOutput(text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text);
      })
      .catch((error: unknown) => setOutput(String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="dev-tester">
      <p className="label">Test read (dev only)</p>
      <form onSubmit={submit}>
        <div className="dev-row">
          <select
            className="input"
            aria-label="Operation"
            value={op}
            onChange={(e) => setOp(e.target.value as Op)}
          >
            <option value="tree">tree</option>
            <option value="read">read</option>
            <option value="write">write</option>
            <option value="undo">undo</option>
          </select>
          <input
            className="input mono"
            aria-label={op === 'undo' ? 'Op id' : 'Path'}
            placeholder={op === 'undo' ? 'opId from a write' : 'src/index.ts'}
            disabled={op === 'tree'}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button type="submit" className="btn btn-lg" disabled={busy || (op !== 'tree' && !path)}>
            Send
          </button>
        </div>
        {op === 'write' && (
          <>
            <textarea
              className="input mono dev-content"
              aria-label="Content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <p className="hint">
              {lastRead?.path === path
                ? 'Modify: sends the hash from your last read.'
                : 'Create: no hash. Read the file first to modify it.'}
            </p>
          </>
        )}
      </form>
      {output && <pre className="mono dev-output">{output}</pre>}
    </section>
  );
}
