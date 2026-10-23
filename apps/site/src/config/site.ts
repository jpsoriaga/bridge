// Where the site lives and where it links. SITE_URL is the one place the domain goes: the
// canonical URL, Open Graph tags, robots.txt and sitemap.xml are all built from it
// (vite.config.ts). README.md "Switching to a new domain" has the other steps.
export const SITE_URL = 'https://bridge.jpsoriaga.me';

export const REPO = 'jpsoriaga/bridge';
export const GITHUB_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${GITHUB_URL}/releases`;
// Unauthenticated, so GitHub allows 60 requests an hour per visitor's IP address.
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
export const AUTHOR_URL = 'https://jpsoriaga.me';

/** A file in the repository, as GitHub shows it. */
export const repoFile = (path: string): string => `${GITHUB_URL}/blob/main/${path}`;

export const LINKS = {
  github: GITHUB_URL,
  releases: RELEASES_URL,
  beta: repoFile('BETA.md'),
  betaInstall: `${repoFile('BETA.md')}#2-install-the-app`,
  betaFreePlans: `${repoFile('BETA.md')}#tips-for-free-and-go-plans`,
  betaUninstall: `${repoFile('BETA.md')}#uninstall-completely`,
  changelog: repoFile('CHANGELOG.md'),
  security: repoFile('SECURITY.md'),
  privacy: repoFile('PRIVACY.md'),
  license: repoFile('LICENSE'),
  issues: `${GITHUB_URL}/issues`,
  author: AUTHOR_URL
} as const;
