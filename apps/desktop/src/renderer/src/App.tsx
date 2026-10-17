import { useState } from 'react';
import { MODE_DESCRIPTIONS, MODE_LABELS, MODES, type Mode } from '@bridge/shared';
import { Logo } from './Logo';

export function App() {
  const [mode, setMode] = useState<Mode>('manual');

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>Bridge</span>
        </div>
        <span className="status">
          <span className="dot" />
          Not connected
        </span>
      </header>

      <main className="panel">
        <section>
          <p className="label">Project</p>
          <p className="value">No project selected</p>
        </section>

        <section>
          <p className="label" id="mode-label">
            Mode
          </p>
          <div className="segmented" role="radiogroup" aria-labelledby="mode-label">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={m === mode}
                onClick={() => setMode(m)}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <p className="hint">{MODE_DESCRIPTIONS[mode]}</p>
        </section>
      </main>

      <footer className="footer">v{window.bridge.version}</footer>
    </div>
  );
}
