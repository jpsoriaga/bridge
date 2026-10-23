import type { ReactNode } from 'react';
import { LINKS } from '../config/site';
import { Icon } from './Icon';
import { Section } from './Section';

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: 'Is it free?',
    a: (
      <>
        Yes. Bridge is free and open source under the MIT license. There’s no paid version, no
        account and no ads.
      </>
    )
  },
  {
    q: 'Does it work on the Free and Go plans?',
    a: (
      <>
        Yes. Bridge works with the chat on chatgpt.com whatever your plan, because it uses the same
        web page you already chat on. Those plans limit how many messages you can send in a few
        hours, so Manual or Auto-apply suits them better than Full auto, which spends a message on
        every step.
      </>
    )
  },
  {
    q: 'Is it affiliated with OpenAI?',
    a: (
      <>
        No. Bridge is an independent open-source project by one person. It isn’t affiliated with or
        endorsed by OpenAI. It works with the ChatGPT web page in your browser, and uses no API.
      </>
    )
  },
  {
    q: 'Why does macOS or Windows warn me?',
    a: (
      <>
        Bridge’s builds aren’t signed yet. Signing costs a yearly fee to Apple and to a Windows
        certificate authority, and without it your computer can’t tell who made the app, so it warns
        before the first run. It isn’t a virus warning.{' '}
        <a className="link" href={LINKS.betaInstall}>
          BETA.md
        </a>{' '}
        shows how to open it anyway, and each release lists SHA-256 sums so you can check the
        download.
      </>
    )
  },
  {
    q: 'Which browsers work?',
    a: (
      <>
        Google Chrome, Microsoft Edge and Brave, and other Chromium browsers with side panels.
        Firefox and Safari aren’t supported. The desktop app runs on macOS, Windows 10 or 11
        (64-bit) and 64-bit Linux.
      </>
    )
  },
  {
    q: 'Where does my code go?',
    a: (
      <>
        It stays on your computer. The app reads and writes files only inside the project folder you
        open, and the extension talks only to the app, over 127.0.0.1. A file leaves your computer
        only when you send it to the chat, and then it goes to the chat service under its own
        privacy policy. Likely secrets are replaced with [redacted] first.{' '}
        <a className="link" href={LINKS.privacy}>
          PRIVACY.md
        </a>{' '}
        lists everything Bridge stores.
      </>
    )
  },
  {
    q: 'How do I uninstall it?',
    a: (
      <>
        Unpair in the app, remove the extension from your browser’s extensions page, then delete the
        app and its data folder (
        <code className="text-sm">~/Library/Application Support/Bridge</code> on macOS,{' '}
        <code className="text-sm">%APPDATA%\Bridge</code> on Windows,{' '}
        <code className="text-sm">~/.config/Bridge</code> on Linux).{' '}
        <a className="link" href={LINKS.betaUninstall}>
          BETA.md
        </a>{' '}
        has the steps for each system.
      </>
    )
  },
  {
    q: 'How can I support Bridge?',
    a: (
      <>
        Bridge is free, and staying free doesn’t depend on money. If it helps you and you’d like to
        chip in, the{' '}
        <a className="link" href="#support">
          Support section
        </a>{' '}
        lists exactly what it pays for. Starring the repository or telling a friend helps too.
      </>
    )
  }
];

export function Faq() {
  return (
    <Section id="faq" label="FAQ" title="Questions people ask">
      <div className="max-w-[48rem] divide-y divide-border border-y border-border">
        {QUESTIONS.map(({ q, a }) => (
          <details key={q} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-4 py-4 text-lg font-medium [&::-webkit-details-marker]:hidden">
              <span className="flex-1">{q}</span>
              <Icon
                name="chevron"
                className="text-fg-muted transition-transform duration-120 group-open:rotate-180"
              />
            </summary>
            <div className="pb-5 text-base text-fg-muted">{a}</div>
          </details>
        ))}
      </div>
    </Section>
  );
}
