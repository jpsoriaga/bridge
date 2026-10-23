// The files to download, from the GitHub Releases API, asked once per page load and kept in
// memory. A stable release wins over a beta; a beta (a GitHub pre-release) is offered only
// while there's no stable one. Anything that goes wrong falls back to the Releases page.
import { RELEASES_API_URL } from '../config/site';
import type { Platform } from './platform';

export type DownloadKey = Platform | 'extension';

/** The parts of the API's release object the site reads. */
export interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: GithubAsset[];
}

export interface Download {
  key: DownloadKey;
  name: string;
  url: string;
  size: number;
}

export interface PickedRelease {
  version: string;
  url: string;
  beta: boolean;
  publishedAt: string | null;
  downloads: Partial<Record<DownloadKey, Download>>;
}

export type FallbackReason = 'error' | 'rate-limited' | 'none';

export type ReleaseResult =
  { status: 'ready'; release: PickedRelease } | { status: 'fallback'; reason: FallbackReason };

// File names from the release workflow (README.md, "Install the app"). The extension is the
// Load unpacked zip: the store zip has no manifest key, so it can't pair.
const ASSET_PATTERNS: Record<DownloadKey, RegExp> = {
  'mac-arm64': /-mac-arm64\.dmg$/,
  'mac-x64': /-mac-x64\.dmg$/,
  windows: /-win-x64-setup\.exe$/,
  linux: /-linux-x86_64\.AppImage$/,
  extension: /^bridge-extension-.+-unpacked\.zip$/
};

export const DOWNLOAD_KEYS = Object.keys(ASSET_PATTERNS) as DownloadKey[];

export function pickDownloads(assets: readonly GithubAsset[]): PickedRelease['downloads'] {
  const downloads: PickedRelease['downloads'] = {};
  for (const key of DOWNLOAD_KEYS) {
    const asset = assets.find((a) => ASSET_PATTERNS[key].test(a.name));
    if (asset) {
      downloads[key] = { key, name: asset.name, url: asset.browser_download_url, size: asset.size };
    }
  }
  return downloads;
}

/** The newest stable release with an installer, else the newest beta with one. */
export function pickRelease(releases: readonly GithubRelease[]): PickedRelease | null {
  const usable = releases
    .filter((r) => !r.draft)
    .map((r) => ({ release: r, downloads: pickDownloads(r.assets) }))
    .filter(({ downloads }) => Object.keys(downloads).some((key) => key !== 'extension'))
    .sort((a, b) => published(b.release) - published(a.release));
  const chosen = usable.find(({ release }) => !release.prerelease) ?? usable[0];
  if (!chosen) return null;
  const { release, downloads } = chosen;
  return {
    version: release.tag_name.replace(/^v/, ''),
    url: release.html_url,
    beta: release.prerelease,
    publishedAt: release.published_at,
    downloads
  };
}

const published = (r: GithubRelease): number => (r.published_at ? Date.parse(r.published_at) : 0);

const TIMEOUT_MS = 8000;

export async function fetchRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
      // Nothing to send: no cookies, no referrer.
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    });
    if (response.status === 429 || isRateLimited(response)) {
      return { status: 'fallback', reason: 'rate-limited' };
    }
    if (!response.ok) return { status: 'fallback', reason: 'error' };
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return { status: 'fallback', reason: 'error' };
    const release = pickRelease(body.filter(isRelease));
    return release ? { status: 'ready', release } : { status: 'fallback', reason: 'none' };
  } catch {
    return { status: 'fallback', reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

function isRateLimited(response: Response): boolean {
  return response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
}

function isRelease(value: unknown): value is GithubRelease {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tag_name === 'string' &&
    typeof r.html_url === 'string' &&
    typeof r.draft === 'boolean' &&
    typeof r.prerelease === 'boolean' &&
    Array.isArray(r.assets) &&
    r.assets.every(isAsset)
  );
}

function isAsset(value: unknown): value is GithubAsset {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.name === 'string' &&
    typeof a.browser_download_url === 'string' &&
    typeof a.size === 'number'
  );
}

let cached: Promise<ReleaseResult> | null = null;

/** `fetchRelease`, once per page load. A failure is kept too, so the page asks only once. */
export function loadRelease(): Promise<ReleaseResult> {
  cached ??= fetchRelease();
  return cached;
}

/** For tests. */
export function resetReleaseCache(): void {
  cached = null;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
