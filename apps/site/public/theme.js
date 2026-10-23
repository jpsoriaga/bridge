// The theme toggle's saved choice ("light" or "dark"; nothing means follow the system).
// Kept tiny and outside the bundle so it runs before the first paint. Theme.tsx writes it.
try {
  var theme = localStorage.getItem('bridge-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage blocked (private mode, cookies off): follow the system.
}
