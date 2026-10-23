import { Fragment } from 'react';
import { LINKS } from '../config/site';
import { Icon } from './Icon';
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
      <ol className="m-0 grid list-none gap-10 p-0 md:grid-cols-3 md:gap-8" data-reveal="group">
        {STEPS.map((step, i) => (
          <li key={step.title} className="border-t border-fg pt-6">
            <span className="font-mono text-sm text-fg-subtle tabular-nums">Step {i + 1}</span>
            <h3 className="mt-3 mb-3 text-[1.375rem] leading-tight font-semibold tracking-[-0.02em]">
              {step.title}
            </h3>
            <p className="m-0 max-w-[34ch] text-base text-fg-muted">{step.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-16 rounded-xl bg-bg-muted p-6 sm:mt-20 sm:p-8" data-reveal="">
        <h3 className="mt-0 mb-6 text-base font-semibold">Then, every time</h3>
        <ol className="m-0 grid list-none items-start gap-6 p-0 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:gap-5">
          {THEN.map((step, i) => (
            <Fragment key={step.title}>
              {i > 0 ? (
                <li aria-hidden="true" className="hidden pt-0.5 text-fg-subtle md:block">
                  <Icon name="arrowRight" />
                </li>
              ) : null}
              <li>
                <p className="m-0 text-base font-medium">{step.title}</p>
                <p className="mt-1 mb-0 text-sm text-fg-muted">{step.body}</p>
              </li>
            </Fragment>
          ))}
        </ol>
      </div>
    </Section>
  );
}
