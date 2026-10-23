import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELEASES_API_URL } from '../config/site';
import {
  fetchRelease,
  formatSize,
  loadRelease,
  pickDownloads,
  pickRelease,
  resetReleaseCache,
  type GithubRelease
} from './releases';

const asset = (name: string, size = 1000) => ({
  name,
  browser_download_url: `https://github.com/jpsoriaga/bridge/releases/download/x/${name}`,
  size
});

const ALL = (v: string) => [
  asset(`Bridge-${v}-mac-arm64.dmg`),
  asset(`Bridge-${v}-mac-x64.dmg`),
  asset(`Bridge-${v}-win-x64-setup.exe`),
  asset(`Bridge-${v}-linux-x86_64.AppImage`),
  asset(`bridge-extension-${v}.zip`),
  asset(`bridge-extension-${v}-unpacked.zip`),
  asset('SHA256SUMS.txt'),
  asset('latest-mac.yml'),
  asset(`Bridge-${v}-mac-arm64.dmg.blockmap`)
];

const release = (v: string, over: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: `v${v}`,
  html_url: `https://github.com/jpsoriaga/bridge/releases/tag/v${v}`,
  draft: false,
  prerelease: v.includes('-beta'),
  published_at: '2026-10-01T00:00:00Z',
  assets: ALL(v),
  ...over
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  });

afterEach(() => {
  resetReleaseCache();
  vi.unstubAllGlobals();
});

describe('pickDownloads', () => {
  it('finds one file per system, and the Load unpacked zip (not the store zip)', () => {
    const d = pickDownloads(ALL('1.2.0'));
    expect(d['mac-arm64']?.name).toBe('Bridge-1.2.0-mac-arm64.dmg');
    expect(d['mac-x64']?.name).toBe('Bridge-1.2.0-mac-x64.dmg');
    expect(d.windows?.name).toBe('Bridge-1.2.0-win-x64-setup.exe');
    expect(d.linux?.name).toBe('Bridge-1.2.0-linux-x86_64.AppImage');
    expect(d.extension?.name).toBe('bridge-extension-1.2.0-unpacked.zip');
  });

  it('leaves out what a release lacks', () => {
    const d = pickDownloads([asset('Bridge-1.0.0-win-x64-setup.exe')]);
    expect(Object.keys(d)).toEqual(['windows']);
  });
});

describe('pickRelease', () => {
  it('prefers a stable release over a newer beta', () => {
    const picked = pickRelease([
      release('1.3.0-beta.1', { published_at: '2026-10-20T00:00:00Z' }),
      release('1.2.0', { published_at: '2026-10-10T00:00:00Z' })
    ]);
    expect(picked?.version).toBe('1.2.0');
    expect(picked?.beta).toBe(false);
  });

  it('takes the newest stable release', () => {
    const picked = pickRelease([
      release('1.1.0', { published_at: '2026-09-01T00:00:00Z' }),
      release('1.2.0', { published_at: '2026-10-01T00:00:00Z' })
    ]);
    expect(picked?.version).toBe('1.2.0');
  });

  it('offers the newest beta while there is no stable release', () => {
    const picked = pickRelease([
      release('1.2.0-beta.1', { published_at: '2026-10-01T00:00:00Z' }),
      release('1.2.0-beta.2', { published_at: '2026-10-20T00:00:00Z' })
    ]);
    expect(picked).toMatchObject({ version: '1.2.0-beta.2', beta: true });
    expect(picked?.downloads.extension?.name).toBe('bridge-extension-1.2.0-beta.2-unpacked.zip');
  });

  it('skips drafts and releases with no installer', () => {
    expect(pickRelease([release('1.2.0', { draft: true })])).toBeNull();
    expect(
      pickRelease([release('1.2.0', { assets: [asset('bridge-extension-1.2.0-unpacked.zip')] })])
    ).toBeNull();
    expect(pickRelease([])).toBeNull();
  });
});

describe('fetchRelease', () => {
  it('asks the Releases API without credentials and picks a release', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json([release('1.2.0')]));
    const result = await fetchRelease(fetchImpl);
    expect(result).toMatchObject({ status: 'ready', release: { version: '1.2.0', beta: false } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(RELEASES_API_URL);
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('falls back when nothing is published', async () => {
    const result = await fetchRelease(vi.fn<typeof fetch>().mockResolvedValue(json([])));
    expect(result).toEqual({ status: 'fallback', reason: 'none' });
  });

  it('falls back when rate-limited', async () => {
    const limited = json(
      { message: 'API rate limit exceeded' },
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
    );
    expect(await fetchRelease(vi.fn<typeof fetch>().mockResolvedValue(limited))).toEqual({
      status: 'fallback',
      reason: 'rate-limited'
    });
    const tooMany = json({}, { status: 429 });
    expect(await fetchRelease(vi.fn<typeof fetch>().mockResolvedValue(tooMany))).toEqual({
      status: 'fallback',
      reason: 'rate-limited'
    });
  });

  it('falls back on a server error, a network error or an unexpected body', async () => {
    const error = { status: 'fallback', reason: 'error' };
    expect(
      await fetchRelease(vi.fn<typeof fetch>().mockResolvedValue(json({}, { status: 500 })))
    ).toEqual(error);
    expect(
      await fetchRelease(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')))
    ).toEqual(error);
    expect(
      await fetchRelease(vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'x' })))
    ).toEqual(error);
    expect(
      await fetchRelease(vi.fn<typeof fetch>().mockResolvedValue(new Response('not json')))
    ).toEqual(error);
  });

  it('ignores malformed entries', async () => {
    const result = await fetchRelease(
      vi.fn<typeof fetch>().mockResolvedValue(json([{ tag_name: 1 }, release('1.2.0')]))
    );
    expect(result.status).toBe('ready');
  });
});

describe('loadRelease', () => {
  it('asks once per page load', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json([release('1.2.0')]));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([loadRelease(), loadRelease()]);
    expect(a).toBe(b);
    await loadRelease();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('formatSize', () => {
  it('rounds to MB or KB', () => {
    expect(formatSize(104857600)).toBe('100 MB');
    expect(formatSize(524288)).toBe('512 KB');
    expect(formatSize(10)).toBe('1 KB');
  });
});
