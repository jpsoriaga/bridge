import { LINKS } from '../config/site';
import { Logo } from './Logo';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Download', href: '#download' },
      { label: 'How it works', href: '#how-it-works' },
      { label: 'FAQ', href: '#faq' }
    ]
  },
  {
    title: 'Project',
    links: [
      { label: 'GitHub', href: LINKS.github },
      { label: 'BETA.md', href: LINKS.beta },
      { label: 'Changelog', href: LINKS.changelog },
      { label: 'Support', href: '#support' }
    ]
  },
  {
    title: 'Legal',
    links: [
      { label: 'SECURITY.md', href: LINKS.security },
      { label: 'PRIVACY.md', href: LINKS.privacy },
      { label: 'License (MIT)', href: LINKS.license }
    ]
  }
];

export function Footer() {
  return (
    <footer className="mt-12 border-t border-border sm:mt-20">
      <div className="container-page">
        <div className="grid gap-10 py-12 sm:py-16 md:grid-cols-[minmax(0,1fr)_auto] md:gap-16">
          <div className="max-w-[20rem]">
            <a
              href="#top"
              className="inline-flex items-center gap-2 rounded-md text-lg font-semibold tracking-[-0.01em] text-fg no-underline"
            >
              <Logo size={24} />
              Bridge
            </a>
            <p className="mt-3 mb-0 text-sm text-fg-muted">
              Let the chat edit your local project, with you in charge.
            </p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-3 gap-6 sm:gap-12">
            {COLUMNS.map((column) => (
              <div key={column.title}>
                <h2 className="mt-0 mb-3 text-xs font-medium text-fg-muted">{column.title}</h2>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="rounded-sm text-sm text-fg no-underline transition-colors duration-(--motion-fast) hover:text-fg-muted"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-5 pb-10 text-xs text-fg-muted sm:pb-14 sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0">Not affiliated with or endorsed by OpenAI.</p>
          <p className="m-0">
            Made by{' '}
            <a className="link text-fg-muted" href={LINKS.author}>
              John Patrick Soriaga
            </a>
            , 2026
          </p>
        </div>
      </div>
    </footer>
  );
}
