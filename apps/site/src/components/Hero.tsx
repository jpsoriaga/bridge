import { LINKS } from '../config/site';
import { ChatDemo } from './ChatDemo';
import { GithubMark, Icon } from './Icon';

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="pt-16 sm:pt-24 lg:pt-32">
      <div className="container-page">
        <h1
          id="hero-title"
          className="m-0 max-w-[13ch] text-display font-bold text-balance text-fg sm:max-w-[15ch]"
        >
          Let the ChatGPT web chat edit your local project.
        </h1>
        <div className="mt-8 grid gap-8 sm:mt-10 lg:grid-cols-[minmax(0,36rem)_auto] lg:items-end lg:justify-between">
          <p className="m-0 text-lead text-pretty text-fg-muted">
            Even on the Free plan. Each change the chat suggests shows up as a diff under its reply,
            and nothing is written until you click Apply.
          </p>
          <div className="flex flex-col gap-4 lg:items-end">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <a href="#download" className="btn btn-accent btn-xl">
                <Icon name="download" />
                Download
              </a>
              <a
                href={LINKS.github}
                className="inline-flex items-center gap-2 rounded-md text-sm font-medium text-fg-muted no-underline transition-colors duration-120 hover:text-fg"
              >
                <GithubMark />
                GitHub
              </a>
            </div>
            <p className="m-0 text-xs text-fg-muted">
              macOS, Windows and Linux · Chrome, Edge or Brave · Free and open source
            </p>
          </div>
        </div>
      </div>
      <div className="container-wide mt-14 sm:mt-20">
        <ChatDemo />
      </div>
    </section>
  );
}
