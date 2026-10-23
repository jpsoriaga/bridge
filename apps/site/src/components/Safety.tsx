import { LINKS } from '../config/site';
import { Icon, type IconName } from './Icon';
import { Section } from './Section';

const POINTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'laptop',
    title: 'Stays on your machine',
    body: 'The app listens on 127.0.0.1 only, and the extension talks only to it. No accounts, no telemetry.'
  },
  {
    icon: 'key',
    title: 'Fingerprint pairing',
    body: 'A pairing is kept only after you confirm the same fingerprint in the app and in the extension.'
  },
  {
    icon: 'folder',
    title: 'Only your project folder',
    body: 'Paths outside the folder are refused, and so are .git, .env files and keys inside it.'
  },
  {
    icon: 'terminal',
    title: 'Commands you allow',
    body: 'Only commands on your allowlist run, matched exactly, without a shell.'
  },
  {
    icon: 'undo',
    title: 'Backups and undo',
    body: 'Every write, delete and rename is backed up first. Undo it from the card or the app.'
  },
  {
    icon: 'lock',
    title: 'Secrets redacted',
    body: 'Likely secrets in files and command output become [redacted] before they reach the message box.'
  }
];

export function Safety() {
  return (
    <Section
      id="safety"
      layout="split"
      title="The chat suggests. You stay in charge."
      intro={
        <>
          Bridge lets a chat change files on your computer, so it’s built to keep that reach small.{' '}
          <a className="link" href={LINKS.security}>
            SECURITY.md
          </a>{' '}
          has the threat model, every control and the known limits.
        </>
      }
    >
      <ul className="m-0 grid list-none gap-x-10 p-0 sm:grid-cols-2 sm:gap-y-2" data-reveal="group">
        {POINTS.map((point) => (
          <li key={point.title} className="flex gap-4 border-t border-border py-6">
            <Icon name={point.icon} size={20} className="mt-0.5 text-fg" />
            <div>
              <h3 className="mt-0 mb-1.5 text-lg font-semibold tracking-[-0.01em]">
                {point.title}
              </h3>
              <p className="m-0 text-base text-fg-muted">{point.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
