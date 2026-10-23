import { LINKS } from '../config/site';
import { Section } from './Section';

// `reach` is how much Bridge does on its own (1 to 3), drawn as the card's meter.
const MODES = [
  {
    name: 'Manual',
    line: 'Nothing is written until you click Apply. You press send.',
    tag: 'Default',
    reach: 1
  },
  {
    name: 'Auto-apply',
    line: 'Edits are written as soon as a reply finishes, each with Undo. You still press send.',
    reach: 2
  },
  {
    name: 'Full auto',
    line: 'Bridge applies edits, runs the commands you allowed and sends the next message itself, up to a step limit you set.',
    tag: 'Opt-in',
    warning: true,
    reach: 3
  }
];

export function Modes() {
  return (
    <Section
      id="modes"
      title="You choose how much happens on its own"
      intro="Switch modes in the app. The extension can only ask; the app decides."
    >
      <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-3" data-reveal="group">
        {MODES.map((mode) => (
          <li
            key={mode.name}
            className={`flex flex-col rounded-xl border p-6 sm:p-7 ${
              mode.warning ? 'border-warning/35' : 'border-border'
            }`}
          >
            <span
              className="flex gap-1"
              role="img"
              aria-label={`Bridge does ${['little', 'more', 'the most'][mode.reach - 1]} on its own`}
            >
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  className={`h-1 w-6 rounded-full ${
                    n > mode.reach ? 'bg-border' : mode.warning ? 'bg-warning' : 'bg-fg'
                  }`}
                />
              ))}
            </span>
            <div className="mt-8 flex items-center gap-2">
              <h3 className="m-0 text-[1.375rem] leading-tight font-semibold tracking-[-0.02em]">
                {mode.name}
              </h3>
              {mode.tag ? (
                <span className="badge" data-tone={mode.warning ? 'warning' : undefined}>
                  {mode.tag.toLowerCase()}
                </span>
              ) : null}
            </div>
            <p className="mt-3 mb-0 text-base text-fg-muted">{mode.line}</p>
          </li>
        ))}
      </ul>

      <div className="mt-10 grid gap-6 md:grid-cols-2 md:gap-8" data-reveal="group">
        <p className="m-0 text-base text-fg-muted">
          <strong className="font-semibold text-fg">Full auto is off until you turn it on</strong>,
          and the app asks you to confirm every time. It turns off again when you restart Bridge or
          start a new session. It clicks the chat’s send button for you, and automating the chat
          this way may break its terms of use, so use it knowingly.
        </p>
        <p className="m-0 text-base text-fg-muted">
          <strong className="font-semibold text-fg">
            Deletes, renames and files like package.json
          </strong>{' '}
          always wait for your click, in every mode.
        </p>
      </div>

      <aside
        aria-label="Tip for Free and Go plans"
        className="mt-10 rounded-xl border border-border p-5 text-base sm:p-6"
        data-reveal=""
      >
        <p className="m-0 text-fg-muted">
          <strong className="font-semibold text-fg">On the Free or Go plan?</strong> The chat limits
          how many messages you can send in a few hours, and Full auto spends one on every step.
          Manual or Auto-apply lets you decide when each message goes, so your messages last longer.{' '}
          <a className="link" href={LINKS.betaFreePlans}>
            More tips
          </a>
        </p>
      </aside>
    </Section>
  );
}
