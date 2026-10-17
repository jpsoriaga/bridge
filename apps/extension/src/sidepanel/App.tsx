import { MODE_LABELS, MODES } from '@bridge/shared';
import { Logo } from './Logo';

export function App() {
  return (
    <div className="panel">
      <header className="panel-header">
        <div className="brand">
          <Logo />
          <span>Bridge</span>
        </div>
        <span className="status">
          <span className="dot" />
          Not connected
        </span>
      </header>

      <main className="panel-body">
        <p className="empty">Open the Bridge desktop app to connect.</p>
        <p className="hint">Modes: {MODES.map((m) => MODE_LABELS[m]).join(' · ')}</p>
      </main>
    </div>
  );
}
