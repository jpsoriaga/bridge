import { LINKS } from '../config/site';
import { Section } from './Section';

const STEPS = [
  {
    title: 'Install the app',
    body: 'Download Bridge for macOS, Windows or Linux and open your project folder. The app is the only part that reads or writes your files.'
  },
  {
    title: 'Add the extension',
    body: 'Load the Bridge extension in Chrome, Edge or Brave. It works on chatgpt.com only, and talks only to the app on your computer.'
  },
  {
    title: 'Pair them',
    body: 'The app shows a 6-digit code. Type it in the side panel, check that both show the same fingerprint, and click They match. You do this once.'
  }
];

const THEN = [
  { title: 'Chat', body: 'Click Start session in the side panel, then ask for a change.' },
  { title: 'Review the diff', body: 'Each file the chat writes gets a card under the reply.' },
  { title: 'Apply', body: 'Bridge backs up the old file and writes the new one. Undo any time.' }
];

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      label="How it works"
      title="Set it up once, then keep chatting"
      intro={
        <>
          Setup takes about ten minutes.{' '}
          <a className="link" href={LINKS.beta}>
            BETA.md
          </a>{' '}
          walks you through each step, with screenshots.
        </>
      }
    >
      <ol className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="rounded-lg border border-border p-5 sm:p-6">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-bg-muted font-mono text-sm tabular-nums text-fg">
              {i + 1}
            </span>
            <h3 className="mt-4 mb-2 text-lg font-semibold">{step.title}</h3>
            <p className="m-0 text-base text-fg-muted">{step.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-6 rounded-lg border border-dashed border-border-strong p-5 sm:p-6">
        <h3 className="mt-0 mb-4 text-base font-semibold">Then, every time</h3>
        <ol className="m-0 grid list-none gap-5 p-0 sm:grid-cols-3">
          {THEN.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="font-mono text-sm text-fg-subtle tabular-nums" aria-hidden="true">
                {String.fromCharCode(97 + i)}.
              </span>
              <div>
                <p className="m-0 text-base font-medium">{step.title}</p>
                <p className="mt-1 mb-0 text-sm text-fg-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
