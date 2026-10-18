import type { DesktopState } from '../../preload/api';
import { Icon } from './Icon';

export interface Step {
  id: 'pair' | 'project' | 'commands' | 'session';
  title: string;
  hint: string;
  done: boolean;
}

/** The four first-run steps, each ticked by what has actually happened. */
export function onboardingSteps(state: DesktopState): Step[] {
  return [
    {
      id: 'pair',
      title: 'Pair the extension',
      hint: 'Click Pair extension below and type the code into the Bridge side panel in Chrome.',
      done: state.paired
    },
    {
      id: 'project',
      title: 'Open a project',
      hint: 'Choose the folder the chat may read and edit. Nothing outside it is reachable.',
      done: state.project !== null && state.project.missing !== true
    },
    {
      id: 'commands',
      title: 'Confirm commands',
      hint: 'Pick which commands the chat may run in this project, if any. Settings → Commands.',
      done: state.allowlist !== null
    },
    {
      id: 'session',
      title: 'Start a session on chatgpt.com',
      hint: 'Open a chat, then click Start session in the Bridge side panel and press send.',
      done: state.onboarding.sessionStarted
    }
  ];
}

/**
 * The first-run checklist. It ticks itself off as each step happens and can be closed;
 * Help → Getting started brings it back.
 */
export function Onboarding({
  state,
  onGo
}: {
  state: DesktopState;
  /** Jumps to where a step is done. */
  onGo: (step: Step['id']) => void;
}) {
  const steps = onboardingSteps(state);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <div className="section-head">
        <h2 className="section-title" id="onboarding-title">
          {next ? 'Get started' : 'You’re set up'}
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close the checklist"
          title="Close (Help → Getting started brings it back)"
          onClick={() => void window.bridge.setOnboardingDismissed(true)}
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="hint" id="onboarding-progress">
        {done} of {steps.length} done
      </p>
      <ol className="checklist" aria-describedby="onboarding-progress">
        {steps.map((step) => (
          <li key={step.id} className="checklist-item" data-done={step.done}>
            <span className="check" aria-hidden="true">
              <Icon name={step.done ? 'check' : 'circle'} />
            </span>
            <span className="checklist-text">
              <span className="checklist-title">
                {step.title}
                <span className="sr-only">{step.done ? ' (done)' : ' (to do)'}</span>
              </span>
              {step === next && <span className="checklist-hint">{step.hint}</span>}
            </span>
            {step === next && step.id !== 'session' && (
              <button type="button" className="btn" onClick={() => onGo(step.id)}>
                {step.id === 'pair' ? 'Pair' : step.id === 'project' ? 'Open folder…' : 'Commands'}
              </button>
            )}
          </li>
        ))}
      </ol>
      {!next && (
        <button
          type="button"
          className="btn"
          onClick={() => void window.bridge.setOnboardingDismissed(true)}
        >
          Done
        </button>
      )}
    </section>
  );
}
