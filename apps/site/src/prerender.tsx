import { renderToString } from 'react-dom/server';
import { App } from './App';

// The page as HTML, written into dist/index.html at build time (scripts/prerender.mjs), so
// it shows before the script runs. main.tsx then hydrates it.
export function render(): string {
  return renderToString(<App />);
}
