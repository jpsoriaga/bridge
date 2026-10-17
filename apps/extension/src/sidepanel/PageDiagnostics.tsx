import { useState } from 'react';
import { panelWindowId, request } from './request';

/**
 * Dev builds only (`import.meta.env.DEV`): what Bridge's page script sees on the active
 * chat tab (selector matches, the last reply's markers and how they parsed), copied to the
 * clipboard to paste into a bug report when chatgpt.com changes its markup.
 */
export function PageDiagnostics() {
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = () => {
    setCopied(false);
    void panelWindowId()
      .then((windowId) => request<unknown>({ type: 'page-diagnostics', windowId }))
      .then((result) => {
        const text = JSON.stringify(result ?? { error: 'No answer.' }, null, 2);
        setReport(text);
        return navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false)
        );
      });
  };

  return (
    <section>
      <p className="label">Page diagnostics (dev only)</p>
      <p className="hint">
        What Bridge sees on this chat page. Copied to the clipboard, to paste into a bug report.
      </p>
      <button type="button" className="btn action" onClick={run}>
        Copy diagnostics
      </button>
      {copied && <p className="hint">Copied.</p>}
      {report && <pre className="dev-output">{report}</pre>}
    </section>
  );
}
