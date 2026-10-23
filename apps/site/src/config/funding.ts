// What support pays for, and where it can be sent. Updated by hand (README.md, "Funding"):
// nothing here is fetched or tracked.

export interface FundingGoal {
  id: string;
  title: string;
  /** What it buys, in one sentence. */
  detail: string;
  /** In US dollars. */
  goal: number;
  /** In US dollars, received so far. Once it reaches `goal`, the item shows as funded. */
  raised: number;
  cadence: 'one-time' | 'per year';
  /** Shows the goal as "about $12". */
  approximate?: boolean;
}

export const FUNDING_GOALS: readonly FundingGoal[] = [
  {
    id: 'chrome-web-store',
    title: 'Chrome Web Store developer fee',
    detail:
      'Lets Bridge go on the Chrome Web Store, for one-click install and automatic updates in Chrome.',
    goal: 5,
    raised: 0, // TODO: Jaypee: update when support comes in
    cadence: 'one-time'
  },
  {
    id: 'domain',
    title: 'A domain for this page',
    detail: 'A short address of its own. Until then the page lives on bridge.jpsoriaga.me.',
    goal: 12,
    raised: 0, // TODO: Jaypee: update when support comes in
    cadence: 'per year',
    approximate: true
  }
];

export interface SupportLinks {
  /** https://github.com/sponsors/<you> */
  githubSponsors: string;
  /** https://ko-fi.com/<you> */
  kofi: string;
  /** The QR image's path under public/, e.g. '/gcash-qr.png'. */
  gcashQr: string;
}

// An empty value hides its button.
export const SUPPORT_LINKS: SupportLinks = {
  githubSponsors: '', // TODO: Jaypee: your GitHub Sponsors URL
  kofi: '', // TODO: Jaypee: your Ko-fi URL
  gcashQr: '' // TODO: Jaypee: add public/gcash-qr.png, then set this to '/gcash-qr.png'
};
