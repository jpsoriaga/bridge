import { useState, type FormEvent } from 'react';
import { OpId } from '@bridge/shared';
import type { RequestOutcome, WorkerRequest } from '../messages';

type Op = 'tree' | 'read' | 'write' | 'undo';

/**
 * Dev builds only (`import.meta.env.DEV`): send tree, read, write or undo to the desktop by
 * hand, to try the sandbox. A write reuses the hash from the last read of the same path, so
 * reading first makes it a modify and skipping the read makes it a create. Undo takes the
 * `opId` a write returned, and is pre-filled with the last one.
 */
export function DevFileTester() {
  const [op, setOp] = useState<Op>('read');
  const [path, setPath] = useState('');
  const [opId, setOpId] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [lastRead, setLastRead] = useState<{ path: string; hash: string } | null>(null);

  const value = op === 'undo' ? opId : path;
  const invalidOpId = op === 'undo' && opId !== '' && !OpId.safeParse(opId).success;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalidOpId) return;
    const request: Extract<WorkerRequest, { type: 'dev-file' }>['request'] =
      op === 'tree'
        ? { type: 'tree', payload: {} }
        : op === 'read'
          ? { type: 'read', payload: { path } }
          : op === 'undo'
            ? { type: 'undo', payload: { opId } }
            : {
                type: 'write',
                payload:
                  lastRead?.path === path
                    ? { path, content, baseHash: lastRead.hash }
                    : { path, content }
              };
    setBusy(true);
    void chrome.runtime
      .sendMessage<WorkerRequest, RequestOutcome<unknown> | undefined>({
        type: 'dev-file',
        request
      })
      .then((outcome) => {
        if (!outcome) {
          // The worker drops requests it can't parse without replying.
          setOutput('The extension refused this request. Check the path or op id.');
          return;
        }
        if (outcome.ok && op === 'read') {
          const { hash, content: text } = outcome.result as { hash: string; content: string };
          setLastRead({ path, hash });
          setContent(text);
        }
        if (outcome.ok && op === 'write') {
          setLastRead(null);
          setOpId((outcome.result as { opId: string }).opId);
        }
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
            aria-invalid={invalidOpId}
            placeholder={op === 'undo' ? 'op id from a write' : 'src/index.ts'}
            disabled={op === 'tree'}
            value={value}
            onChange={(e) => (op === 'undo' ? setOpId : setPath)(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-lg"
            disabled={busy || invalidOpId || (op !== 'tree' && !value)}
          >
            Send
          </button>
        </div>
        {op === 'undo' && (
          <p className="hint">
            {invalidOpId
              ? 'That isn’t an op id. Undo takes the "opId" from a write’s reply, not a path.'
              : 'Undoes one write by its op id (filled in from your last write). Refused with "conflict" if the file changed since.'}
          </p>
        )}
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
