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
      label="Safe by design"
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
      <ul className="m-0 grid list-none gap-x-8 gap-y-8 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {POINTS.map((point) => (
          <li key={point.title} className="border-t border-border pt-5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-fg">
              <Icon name={point.icon} />
            </span>
            <h3 className="mt-4 mb-1.5 text-base font-semibold">{point.title}</h3>
            <p className="m-0 text-sm text-fg-muted">{point.body}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
