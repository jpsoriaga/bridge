import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { get as httpsGet } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { MAX_BINARY_BYTES } from '@bridge/shared';
import { FileOpError } from './operations';

/** Redirects a download may follow, each to https again. */
export const MAX_REDIRECTS = 5;
/** The whole download, redirects included, must finish within this. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** A response as `download` reads it. */
export interface DownloadResponse {
  status: number;
  /** Lowercase names. */
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
  /** Stops reading; the connection is dropped. */
  destroy(): void;
}

export interface DownloadDeps {
  /**
   * One GET, no redirects followed, resolving the host through `lookup` (which refuses
   * local addresses). Tests pass a fake.
   */
  get?: (
    url: URL,
    options: { lookup: LookupFunction; signal: AbortSignal }
  ) => Promise<DownloadResponse>;
  /** DNS, for the default `lookup`. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

const V4_PRIVATE: readonly [number, number][] = [
  // [network, prefix length]
  [0x00000000, 8], // "this" network
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // benchmarking
  [0xe0000000, 4], // multicast
  [0xf0000000, 4] // reserved, broadcast
];

function v4Number(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

/**
 * An address on this computer, the local network, or otherwise not on the public internet:
 * loopback, private ranges, link-local, carrier-grade NAT, multicast, unique-local IPv6, and
 * IPv4 written inside IPv6. Downloads never go there, so the chat can't reach a router's
 * admin page or a service on localhost through Bridge.
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4Number(ip);
    return V4_PRIVATE.some(
      ([net, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === net
    );
  }
  if (kind !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped =
    /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  if (lower === '::' || lower === '::1') return true;
  const first = Number.parseInt(lower.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // multicast
    lower.startsWith('64:ff9b:') || // NAT64, an IPv4 address in disguise
    lower.startsWith('2002:') // 6to4, likewise
  );
}

/** Hosts that name this computer or the local network whatever DNS says. */
function isLocalName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal') ||
    name.endsWith('.lan') ||
    !name.includes('.')
  );
}

/** A refusal, as the error the caller turns into a reply. */
const refuse = (code: 'not-https' | 'private-address' | 'download-failed' | 'too-large') =>
  new FileOpError(code);

/** Checks a URL before connecting: https, no credentials, no local host. */
export function checkUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw refuse('download-failed');
  }
  if (url.protocol !== 'https:') throw refuse('not-https');
  if (url.username !== '' || url.password !== '') throw refuse('download-failed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? isPrivateAddress(host) : isLocalName(host)) throw refuse('private-address');
  return url;
}

/**
 * A DNS lookup that refuses any answer on the local network. It's the lookup the
 * connection itself uses, so a name that resolves to a public address when checked and a
 * local one when connecting (DNS rebinding) can't slip through.
 */
export function safeLookup(resolve: NonNullable<DownloadDeps['resolve']>): LookupFunction {
  return ((host: string, options: unknown, callback: unknown) => {
    const done = (typeof options === 'function' ? options : callback) as (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void;
    const all =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    resolve(host).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
          const error: NodeJS.ErrnoException = new Error('private address');
          error.code = 'EPRIVATE';
          done(error, '');
          return;
        }
        if (all) done(null, addresses);
        else done(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: NodeJS.ErrnoException) => done(error, '')
    );
  }) as LookupFunction;
}

const systemResolve = (host: string) =>
  new Promise<LookupAddress[]>((resolve, reject) =>
    dnsLookup(host, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses)
    )
  );

const nodeGet: NonNullable<DownloadDeps['get']> = (url, { lookup, signal }) =>
  new Promise((resolve, reject) => {
    const request = httpsGet(
      url,
      {
        lookup,
        signal,
        // Nothing about the user: no cookies, no referrer, a plain agent string.
        headers: { 'user-agent': 'Bridge', accept: '*/*' }
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          destroy: () => response.destroy()
        })
    );
    request.on('error', reject);
  });

/**
 * Fetches `raw` into memory: https only, every redirect checked again, no local addresses,
 * at most `maxBytes` (MAX_BINARY_BYTES), within `timeoutMs`. Throws `FileOpError` with
 * `not-https`, `private-address`, `too-large` or `download-failed`.
 */
export async function download(raw: string, deps: DownloadDeps = {}): Promise<Buffer> {
  const get = deps.get ?? nodeGet;
  const lookup = safeLookup(deps.resolve ?? systemResolve);
  const maxBytes = deps.maxBytes ?? MAX_BINARY_BYTES;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let url = checkUrl(raw);
  for (let hop = 0; ; hop += 1) {
    let response: DownloadResponse;
    try {
      response = await get(url, { lookup, signal });
    } catch (error) {
      throw (error as NodeJS.ErrnoException).code === 'EPRIVATE'
        ? refuse('private-address')
        : refuse('download-failed');
    }
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && typeof location === 'string') {
      response.destroy();
      if (hop >= MAX_REDIRECTS) throw refuse('download-failed');
      url = checkUrl(location, url);
      continue;
    }
    if (response.status !== 200) {
      response.destroy();
      throw refuse('download-failed');
    }
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      throw refuse('too-large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          throw refuse('too-large');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof FileOpError) throw error;
      throw refuse('download-failed');
    }
    return Buffer.concat(chunks);
  }
}
