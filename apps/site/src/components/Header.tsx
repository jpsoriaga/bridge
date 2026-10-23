import { LINKS } from '../config/site';
import { GithubMark } from './Icon';
import { Logo } from './Logo';
import { ThemeSwitch } from './Theme';

const NAV = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#modes', label: 'Modes' },
  { href: '#safety', label: 'Safety' },
  { href: '#faq', label: 'FAQ' },
  { href: '#download', label: 'Download' }
];

export function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg">
      <a
        href="#main"
        className="btn btn-primary absolute top-3 left-4 -translate-y-20 focus-visible:translate-y-0"
      >
        Skip to content
      </a>
      <div className="container-page flex h-14 items-center gap-4">
        <a
          href="#top"
          className="flex items-center gap-2 rounded-md text-lg font-semibold tracking-[-0.01em] text-fg no-underline"
        >
          <Logo size={24} />
          Bridge
        </a>
        <nav aria-label="Sections" className="ml-4 hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="rounded-md px-2.5 py-1.5 text-sm font-medium text-fg-muted no-underline transition-colors duration-(--motion-fast) hover:text-fg"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeSwitch />
          <a href={LINKS.github} className="btn" aria-label="Bridge on GitHub">
            <GithubMark />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>
      </div>
    </header>
  );
}
