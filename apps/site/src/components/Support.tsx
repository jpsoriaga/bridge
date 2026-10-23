import { useState } from 'react';
import {
  FUNDING_GOALS,
  SUPPORT_LINKS,
  type FundingGoal,
  type SupportLinks
} from '../config/funding';
import { LINKS } from '../config/site';
import { Dialog } from './Dialog';
import { GithubMark, Icon } from './Icon';
import { Section } from './Section';

export const isFunded = (goal: FundingGoal): boolean => goal.raised >= goal.goal;

const dollars = (n: number): string => `$${n.toLocaleString('en-US')}`;

export function Support({
  goals = FUNDING_GOALS,
  links = SUPPORT_LINKS
}: {
  goals?: readonly FundingGoal[];
  links?: SupportLinks;
}) {
  const [qrOpen, setQrOpen] = useState(false);
  const hasLinks = Boolean(links.githubSponsors || links.kofi || links.gcashQr);

  return (
    <Section
      id="support"
      label="Support Bridge"
      title="Help Bridge reach more people"
      intro="Bridge is free and always will be. Support only covers the two costs below, and nothing else. I update the numbers by hand; nothing on this page is tracked."
    >
      <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-2">
        {goals.map((goal) => (
          <FundingItem key={goal.id} goal={goal} />
        ))}
      </ul>

      <div className="mt-8 flex flex-col gap-4">
        {hasLinks ? (
          <div className="flex flex-wrap gap-3">
            {links.githubSponsors ? (
              <a href={links.githubSponsors} className="btn btn-lg">
                <GithubMark />
                GitHub Sponsors
              </a>
            ) : null}
            {links.kofi ? (
              <a href={links.kofi} className="btn btn-lg">
                <Icon name="coffee" />
                Ko-fi
              </a>
            ) : null}
            {links.gcashQr ? (
              <button
                type="button"
                className="btn btn-lg"
                aria-haspopup="dialog"
                onClick={() => setQrOpen(true)}
              >
                <Icon name="qr" />
                GCash
              </button>
            ) : null}
          </div>
        ) : (
          <p className="m-0 text-sm text-fg-muted">Ways to chip in are coming soon.</p>
        )}
        <p className="m-0 text-sm text-fg-muted">
          Can’t chip in? That’s fine. A{' '}
          <a className="link" href={LINKS.github}>
            star on GitHub
          </a>
          , a bug report or telling a friend in the same boat helps just as much.
        </p>
      </div>

      {qrOpen && links.gcashQr ? (
        <Dialog title="Support with GCash" onClose={() => setQrOpen(false)}>
          <img
            src={links.gcashQr}
            alt="GCash QR code for supporting Bridge"
            width={320}
            height={320}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full rounded-md border border-border bg-bg"
          />
          <p className="mt-3 mb-0 text-sm text-fg-muted">Scan it with the GCash app. Thank you!</p>
        </Dialog>
      ) : null}
    </Section>
  );
}

function FundingItem({ goal }: { goal: FundingGoal }) {
  const funded = isFunded(goal);
  const share = Math.min(1, goal.goal > 0 ? goal.raised / goal.goal : 0);
  const target = `${goal.approximate ? 'about ' : ''}${dollars(goal.goal)}${
    goal.cadence === 'per year' ? '/year' : ' one-time'
  }`;

  return (
    <li className="flex flex-col rounded-lg border border-border p-5 sm:p-6" data-funded={funded}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="m-0 text-base font-semibold">{goal.title}</h3>
        <span className="text-sm text-fg-muted">{target}</span>
      </div>
      <p className="mt-1 mb-0 flex-1 text-sm text-fg-muted">{goal.detail}</p>
      <div className="mt-5">
        {funded ? (
          <p className="m-0 flex items-center gap-2 text-sm font-medium text-success">
            <Icon name="check" />
            Funded, thank you!
          </p>
        ) : (
          <>
            <div
              role="progressbar"
              aria-label={`${goal.title}: raised so far`}
              aria-valuemin={0}
              aria-valuemax={goal.goal}
              aria-valuenow={goal.raised}
              aria-valuetext={`${dollars(goal.raised)} of ${dollars(goal.goal)}`}
              className="h-1 overflow-hidden rounded-full bg-bg-muted"
            >
              {/* SVG, so the width is an attribute: the site's CSP refuses inline styles. */}
              <svg className="block h-1 w-full" aria-hidden="true" focusable="false">
                <rect width={`${share * 100}%`} height="4" rx="2" className="fill-fg" />
              </svg>
            </div>
            <p className="mt-2 mb-0 text-xs text-fg-muted tabular-nums">
              {dollars(goal.raised)} / {dollars(goal.goal)}
            </p>
          </>
        )}
      </div>
    </li>
  );
}
