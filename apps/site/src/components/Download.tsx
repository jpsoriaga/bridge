import { useEffect, useState } from 'react';
import { LINKS, RELEASES_URL } from '../config/site';
import { detectPlatform, primaryPlatform, type Detected } from '../lib/platform';
import {
  DOWNLOAD_KEYS,
  formatSize,
  loadRelease,
  type Download as DownloadFile,
  type DownloadKey,
  type PickedRelease,
  type ReleaseResult
} from '../lib/releases';
import { Icon } from './Icon';
import { Section } from './Section';

const LABELS: Record<DownloadKey, { name: string; detail: string; button: string }> = {
  'mac-arm64': {
    name: 'macOS, Apple silicon',
    detail: 'M1 or later',
    button: 'Download for macOS'
  },
  'mac-x64': {
    name: 'macOS, Intel',
    detail: 'Intel processor',
    button: 'Download for macOS (Intel)'
  },
  windows: { name: 'Windows', detail: 'Windows 10 or 11, 64-bit', button: 'Download for Windows' },
  linux: { name: 'Linux AppImage', detail: '64-bit (x86_64)', button: 'Download for Linux' },
  extension: {
    name: 'Browser extension',
    detail: 'Chrome, Edge or Brave, loaded unpacked',
    button: 'Download the extension'
  }
};

const FALLBACK_TEXT = {
  error: 'The download links couldn’t be loaded from GitHub just now.',
  'rate-limited':
    'GitHub is limiting requests from your network for a while, so the links can’t load here.',
  none: 'There’s no published release yet.'
} as const;

function useDetected(): Detected {
  const [detected, setDetected] = useState<Detected>({ os: 'other', arch: 'unknown' });
  useEffect(() => {
    let live = true;
    void detectPlatform(navigator).then((d) => {
      if (live) setDetected(d);
    });
    return () => {
      live = false;
    };
  }, []);
  return detected;
}

function useRelease(): ReleaseResult | null {
  const [result, setResult] = useState<ReleaseResult | null>(null);
  useEffect(() => {
    let live = true;
    void loadRelease().then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, []);
  return result;
}

export function Download() {
  const detected = useDetected();
  const result = useRelease();

  return (
    <Section
      id="download"
      layout="panel"
      title="Get Bridge"
      intro="You need both parts: the app for your computer and the extension for your browser. Both are free."
    >
      <div aria-live="polite" aria-busy={result === null}>
        {result === null ? (
          <Loading />
        ) : result.status === 'ready' ? (
          <Ready release={result.release} detected={detected} />
        ) : (
          <Fallback reason={result.reason} />
        )}
      </div>
      <Notes />
    </Section>
  );
}

function Loading() {
  return (
    <div
      className="rounded-xl border border-border bg-bg p-5 sm:p-8"
      aria-label="Loading downloads"
    >
      <div className="h-3.5 w-40 rounded-sm bg-bg-muted" />
      <div className="mt-6 h-11 w-64 max-w-full rounded-md bg-bg-muted" />
      <div className="mt-3 h-3.5 w-72 max-w-full rounded-sm bg-bg-muted" />
    </div>
  );
}

function Ready({ release, detected }: { release: PickedRelease; detected: Detected }) {
  const wanted = primaryPlatform(detected);
  const primary = wanted ? release.downloads[wanted] : undefined;
  const extension = release.downloads.extension;
  const others = DOWNLOAD_KEYS.filter((key) => key !== primary?.key && key !== 'extension')
    .map((key) => release.downloads[key])
    .filter((d): d is DownloadFile => d !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-border-strong bg-bg">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-3 sm:px-8">
          <span className="font-mono text-sm font-medium">Bridge {release.version}</span>
          {release.beta ? (
            <span className="badge" data-tone="warning" title="A test version for early testers">
              beta
            </span>
          ) : null}
          {release.publishedAt ? (
            <span className="text-xs text-fg-muted">{formatDate(release.publishedAt)}</span>
          ) : null}
          <a className="link ml-auto text-xs" href={release.url}>
            Release notes
          </a>
        </div>

        <div className="grid gap-8 p-5 sm:p-8 md:grid-cols-2">
          <div>
            <p className="mt-0 mb-3 text-xs text-fg-muted">1. The app, for your computer</p>
            {primary ? (
              <>
                <a
                  href={primary.url}
                  className="btn btn-primary btn-xl w-full sm:w-auto sm:min-w-72"
                >
                  <Icon name="download" />
                  {LABELS[primary.key].button}
                </a>
                <p className="mt-2 mb-0 text-xs text-fg-muted">
                  {LABELS[primary.key].name} · {formatSize(primary.size)}
                </p>
                {primary.key === 'mac-arm64' && detected.arch === 'unknown' ? (
                  <p className="mt-3 mb-0 text-sm text-fg-muted">
                    Not sure which Mac you have? Apple menu → About This Mac. “Chip: Apple M…” is
                    Apple silicon; “Processor: Intel” needs the Intel version below.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="m-0 text-sm text-fg-muted">
                Bridge runs on macOS, Windows and Linux computers. Pick yours below.
              </p>
            )}
          </div>
          <div>
            <p className="mt-0 mb-3 text-xs text-fg-muted">2. The extension, for your browser</p>
            {extension ? (
              <>
                <a href={extension.url} className="btn btn-xl w-full sm:w-auto sm:min-w-72">
                  <Icon name="download" />
                  {LABELS.extension.button}
                </a>
                <p className="mt-2 mb-0 text-xs text-fg-muted">
                  {LABELS.extension.detail} · {formatSize(extension.size)}
                </p>
              </>
            ) : (
              <p className="m-0 text-sm text-fg-muted">
                This release has no extension zip.{' '}
                <a className="link" href={RELEASES_URL}>
                  Find it on the Releases page
                </a>
                .
              </p>
            )}
          </div>
        </div>
      </div>

      {others.length > 0 ? (
        <div>
          <h3 className="mt-0 mb-3 text-sm font-semibold">
            {primary ? 'Other systems' : 'All systems'}
          </h3>
          <ul className="m-0 list-none divide-y divide-border rounded-xl border border-border bg-bg p-0">
            {others.map((d) => (
              <li
                key={d.key}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 sm:px-8"
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-base font-medium">{LABELS[d.key].name}</p>
                  <p className="m-0 truncate font-mono text-xs text-fg-muted">
                    {d.name} · {formatSize(d.size)}
                  </p>
                </div>
                <a href={d.url} className="btn" aria-label={`Download ${LABELS[d.key].name}`}>
                  <Icon name="download" />
                  Download
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Fallback({ reason }: { reason: keyof typeof FALLBACK_TEXT }) {
  return (
    <div className="rounded-xl border border-border-strong bg-bg p-5 sm:p-8">
      <p className="m-0 text-base">{FALLBACK_TEXT[reason]}</p>
      <p className="mt-1 mb-0 text-sm text-fg-muted">
        Every installer and the extension zip are on GitHub’s Releases page, under Assets.
      </p>
      <a href={RELEASES_URL} className="btn btn-primary btn-xl mt-6">
        Open the Releases page
        <Icon name="external" />
      </a>
    </div>
  );
}

function Notes() {
  return (
    <div className="mt-10 grid gap-6 text-sm text-fg-muted md:grid-cols-3 md:gap-8">
      <p className="m-0">
        <strong className="font-semibold text-fg">macOS and Windows will warn you</strong> the first
        time. Bridge isn’t signed yet (that costs a yearly fee), so they can’t tell who made it.{' '}
        <a className="link" href={LINKS.betaInstall}>
          BETA.md shows how to open it
        </a>
        .
      </p>
      <p className="m-0">
        <strong className="font-semibold text-fg">On Linux</strong>, make the AppImage executable (
        <code className="text-xs">chmod +x</code>) and run it. Ubuntu 24.04 may need one extra step,
        also in BETA.md.
      </p>
      <p className="m-0">
        <strong className="font-semibold text-fg">Want to check the file?</strong> Each release
        lists SHA-256 sums in <code className="text-xs">SHA256SUMS.txt</code>.
      </p>
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
}
