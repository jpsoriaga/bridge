import { LINKS } from '../config/site';
import { Section } from './Section';

const MODES = [
  {
    name: 'Manual',
    line: 'Nothing is written until you click Apply. You press send.',
    tag: 'Default'
  },
  {
    name: 'Auto-apply',
    line: 'Edits are written as soon as a reply finishes, each with Undo. You still press send.'
  },
  {
    name: 'Full auto',
    line: 'Bridge applies edits, runs the commands you allowed and sends the next message itself, up to a step limit you set.',
    tag: 'Opt-in',
    warning: true
  }
];

export function Modes() {
  return (
    <Section
      id="modes"
      label="Modes"
      title="You choose how much happens on its own"
      intro="Switch modes in the app. The extension can only ask; the app decides."
    >
      <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
        {MODES.map((mode) => (
          <li
            key={mode.name}
            className={`flex flex-col rounded-lg border p-5 sm:p-6 ${
              mode.warning ? 'border-warning/35' : 'border-border'
            }`}
          >
            <div className="flex items-center gap-2">
              <h3 className="m-0 text-lg font-semibold">{mode.name}</h3>
              {mode.tag ? (
                <span className="badge" data-tone={mode.warning ? 'warning' : undefined}>
                  {mode.tag.toLowerCase()}
                </span>
              ) : null}
            </div>
            <p className="mt-2 mb-0 text-base text-fg-muted">{mode.line}</p>
          </li>
        ))}
      </ul>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <p className="m-0 text-sm text-fg-muted">
          <strong className="font-semibold text-fg">Full auto is off until you turn it on</strong>,
          and the app asks you to confirm every time. It turns off again when you restart Bridge or
          start a new session. It clicks the chat’s send button for you, and automating the chat
          this way may break its terms of use, so use it knowingly.
        </p>
        <p className="m-0 text-sm text-fg-muted">
          <strong className="font-semibold text-fg">
            Deletes, renames and files like package.json
          </strong>{' '}
          always wait for your click, in every mode.
        </p>
      </div>

      <aside
        aria-label="Tip for Free and Go plans"
        className="mt-6 rounded-md border border-border bg-bg-muted p-4 text-sm sm:p-5"
      >
        <p className="m-0">
          <strong className="font-semibold">On the Free or Go plan?</strong> The chat limits how
          many messages you can send in a few hours, and Full auto spends one on every step. Manual
          or Auto-apply lets you decide when each message goes, so your messages last longer.{' '}
          <a className="link" href={LINKS.betaFreePlans}>
            More tips
          </a>
        </p>
      </aside>
    </Section>
  );
}
