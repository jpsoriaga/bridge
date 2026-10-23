import { LINKS } from '../config/site';
import { ChatDemo } from './ChatDemo';
import { GithubMark, Icon } from './Icon';

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="pt-12 pb-16 sm:pt-20 sm:pb-24">
      <div className="container-page grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:gap-16">
        <div className="min-w-0">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-fg-muted">
            <span className="dot" data-tone="success" />
            Free and open source · now in beta
          </p>
          <h1 id="hero-title" className="m-0 text-display font-semibold text-balance text-fg">
            Let the ChatGPT web chat edit your local project, even on the Free plan.
          </h1>
          <p className="mt-6 mb-0 max-w-[36rem] text-lead text-pretty text-fg-muted">
            No more pasting files in one by one. Bridge shows each change the chat suggests as a
            diff right under its reply. You click Apply, and the Bridge app writes it into your
            project folder, with undo.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#download" className="btn btn-primary btn-xl">
              <Icon name="download" />
              Download
            </a>
            <a href={LINKS.github} className="btn btn-xl">
              <GithubMark />
              View on GitHub
            </a>
            <a href={LINKS.beta} className="btn btn-xl">
              Read BETA.md
            </a>
          </div>
          <p className="mt-5 mb-0 text-xs text-fg-muted">
            macOS, Windows and Linux · Chrome, Edge or Brave · Runs only on your computer
          </p>
        </div>
        <ChatDemo />
      </div>
    </section>
  );
}
