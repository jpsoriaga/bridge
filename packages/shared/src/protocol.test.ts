import { describe, expect, it } from 'vitest';
import {
  type BridgeConfig,
  candidatePorts,
  ClientMessage,
  clientMessage,
  DEFAULT_PORT,
  E2E_PORT,
  HealthResponse,
  helloProtocol,
  mismatchReason,
  PairFailure,
  PairRequest,
  PairSuccess,
  parseMessage,
  parseMismatchReason,
  PORT_RANGE,
  protocolAdvice,
  proofInput,
  PROTOCOL_VERSION,
  ServerMessage,
  serverMessage,
  UnpairChallengeRequest,
  UnpairChallengeResponse,
  UnpairRequest
} from './protocol';

const token = 'a'.repeat(64);
const nonce = 'b'.repeat(64);
const proof = 'c'.repeat(64);
const raw = (value: unknown) => JSON.stringify(value);
const config: BridgeConfig = {
  mode: 'manual',
  allowlist: ['pnpm test'],
  stepLimit: 10,
  pauseOnFailure: false,
  catchUpAfterSleep: true,
  uiGuidance: 'auto',
  running: null,
  background: [],
  processes: [],
  autoApprove: { changes: false, gated: false, partial: false },
  instance: 'launch-1'
};

describe('client messages', () => {
  it('accepts hello, auth, ping and pong', () => {
    for (const msg of [
      clientMessage('0', 'hello', { nonce }),
      clientMessage('1', 'auth', { proof }),
      clientMessage('2', 'ping', {}),
      clientMessage('3', 'pong', {})
    ]) {
      expect(parseMessage(ClientMessage, raw(msg))).toEqual(msg);
    }
  });

  it.each([
    ['not JSON', '{'],
    ['a bare string', raw('auth')],
    ['an unknown type', raw({ v: 1, id: '1', type: 'write', payload: {} })],
    ['a server-only type', raw({ v: 1, id: '1', type: 'auth_ok', payload: {} })],
    ['the Phase 2 version', raw({ v: 1, id: '1', type: 'ping', payload: {} })],
    ['a missing id', raw({ v: PROTOCOL_VERSION, type: 'ping', payload: {} })],
    ['an empty id', raw({ v: PROTOCOL_VERSION, id: '', type: 'ping', payload: {} })],
    ['an overlong id', raw({ v: PROTOCOL_VERSION, id: 'x'.repeat(65), type: 'ping', payload: {} })],
    ['a missing payload', raw({ v: PROTOCOL_VERSION, id: '1', type: 'ping' })],
    ['extra envelope keys', raw({ v: PROTOCOL_VERSION, id: '1', type: 'ping', payload: {}, x: 1 })],
    ['extra payload keys', raw({ v: PROTOCOL_VERSION, id: '1', type: 'ping', payload: { x: 1 } })],
    [
      'a bearer token in auth',
      raw({ v: PROTOCOL_VERSION, id: '1', type: 'auth', payload: { token } })
    ],
    [
      'a short proof',
      raw({ v: PROTOCOL_VERSION, id: '1', type: 'auth', payload: { proof: 'abc' } })
    ],
    [
      'an uppercase proof',
      raw({ v: PROTOCOL_VERSION, id: '1', type: 'auth', payload: { proof: 'A'.repeat(64) } })
    ],
    [
      'a numeric nonce',
      raw({ v: PROTOCOL_VERSION, id: '1', type: 'hello', payload: { nonce: 1 } })
    ],
    [
      'a server-only challenge',
      raw({
        v: PROTOCOL_VERSION,
        id: '1',
        type: 'challenge',
        payload: { proof, serverNonce: nonce }
      })
    ]
  ])('rejects %s', (_label, input) => {
    expect(parseMessage(ClientMessage, input)).toBeNull();
  });
});

describe('file requests', () => {
  it('accepts tree, read, write and undo', () => {
    for (const msg of [
      clientMessage('1', 'tree', {}),
      clientMessage('2', 'read', { path: 'src/a.ts' }),
      clientMessage('3', 'write', { path: 'a.ts', content: 'x', trigger: 'click' }),
      clientMessage('4', 'write', {
        path: 'a.ts',
        content: '',
        baseHash: 'f'.repeat(64),
        trigger: 'auto'
      }),
      clientMessage('5', 'undo', { opId: '6f1c2b8e-1d2a-4c1b-9e3f-0a1b2c3d4e5f' })
    ]) {
      expect(parseMessage(ClientMessage, raw(msg))).toEqual(msg);
    }
  });

  it.each([
    ['tree with params', { type: 'tree', payload: { depth: 1 } }],
    ['read without a path', { type: 'read', payload: {} }],
    ['read with an empty path', { type: 'read', payload: { path: '' } }],
    ['read with a numeric path', { type: 'read', payload: { path: 1 } }],
    ['write without content', { type: 'write', payload: { path: 'a', trigger: 'click' } }],
    ['write without a trigger', { type: 'write', payload: { path: 'a', content: '' } }],
    [
      'write with an unknown trigger',
      { type: 'write', payload: { path: 'a', content: '', trigger: 'loop' } }
    ],
    [
      'write with a short hash',
      { type: 'write', payload: { path: 'a', content: '', baseHash: 'ab', trigger: 'click' } }
    ],
    [
      'write with extra keys',
      { type: 'write', payload: { path: 'a', content: '', trigger: 'click', mode: 0o777 } }
    ],
    ['undo with an odd op id', { type: 'undo', payload: { opId: '../x' } }],
    ['a delete', { type: 'delete', payload: { path: 'a' } }],
    ['a rename', { type: 'rename', payload: { from: 'a', to: 'b' } }]
  ])('rejects %s', (_label, partial) => {
    expect(
      parseMessage(ClientMessage, raw({ v: PROTOCOL_VERSION, id: '1', ...partial }))
    ).toBeNull();
  });
});

describe('commands and the loop', () => {
  it('accepts run, run_cancel, loop_report and session_end', () => {
    for (const msg of [
      clientMessage('1', 'run', { argv: ['pnpm', 'test'], trigger: 'click' }),
      clientMessage('2', 'run_cancel', { runId: 'r-1' }),
      clientMessage('3', 'loop_report', {
        loopId: 'loop-1',
        state: 'paused',
        step: 3,
        limit: 10,
        reason: 'step-limit',
        event: { kind: 'paused', text: 'Step limit' }
      }),
      clientMessage('4', 'session_end', {})
    ]) {
      expect(parseMessage(ClientMessage, raw(msg))).toEqual(msg);
    }
  });

  it.each([
    [
      'run with a command string',
      { type: 'run', payload: { argv: 'pnpm test', trigger: 'click' } }
    ],
    ['run with an empty argv', { type: 'run', payload: { argv: [], trigger: 'click' } }],
    ['run without a trigger', { type: 'run', payload: { argv: ['ls'] } }],
    ['run with a cwd', { type: 'run', payload: { argv: ['ls'], trigger: 'click', cwd: '/' } }],
    ['run with env', { type: 'run', payload: { argv: ['ls'], trigger: 'click', env: {} } }],
    ['run_cancel with an odd id', { type: 'run_cancel', payload: { runId: '../x' } }],
    [
      'a loop report in an unknown state',
      {
        type: 'loop_report',
        payload: { loopId: 'l', state: 'dancing', step: 0, limit: 10 }
      }
    ],
    [
      'a loop report with a fractional step',
      {
        type: 'loop_report',
        payload: { loopId: 'l', state: 'idle', step: 0.5, limit: 10 }
      }
    ],
    ['a mode change from the extension', { type: 'set_mode', payload: { mode: 'full-auto' } }],
    [
      'an allowlist change from the extension',
      { type: 'set_allowlist', payload: { allowlist: [] } }
    ]
  ])('rejects %s', (_label, partial) => {
    expect(
      parseMessage(ClientMessage, raw({ v: PROTOCOL_VERSION, id: '1', ...partial }))
    ).toBeNull();
  });
});

describe('server messages', () => {
  it('accepts every server type', () => {
    for (const msg of [
      serverMessage('0', 'challenge', { proof, serverNonce: nonce }),
      serverMessage('1', 'auth_ok', {}),
      serverMessage('2', 'auth_error', { reason: 'invalid_proof' }),
      serverMessage('2', 'auth_error', { reason: 'replayed_nonce' }),
      serverMessage('3', 'ping', {}),
      serverMessage('4', 'pong', {}),
      serverMessage('5', 'status', { version: '0.1.0', project: null, config }),
      serverMessage('5', 'status', {
        version: '0.1.0',
        project: { name: 'app', path: '~/app' },
        config: { ...config, mode: 'full-auto', running: { runId: 'r-1', argv: ['pnpm', 'test'] } }
      }),
      serverMessage('7', 'run_output', { runId: 'r-1', chunk: 'ok\n' }),
      serverMessage('8', 'run_exit', {
        runId: 'r-1',
        argv: ['pnpm', 'test'],
        status: 'exited',
        exitCode: 1,
        signal: null,
        durationMs: 1200,
        output: 'FAIL',
        truncated: false
      }),
      serverMessage('9', 'loop_stop', {}),
      serverMessage('r1', 'response', { ok: true, result: { anything: 1 } }),
      serverMessage('r2', 'response', {
        ok: false,
        error: { code: 'traversal', message: 'no' }
      }),
      serverMessage('6', 'error', { code: 'invalid_message', message: 'Bad message' })
    ]) {
      expect(parseMessage(ServerMessage, raw(msg))).toEqual(msg);
    }
  });

  it.each([
    ['an unknown auth_error reason', { type: 'auth_error', payload: { reason: 'nope' } }],
    ['an unknown error code', { type: 'error', payload: { code: 'x', message: '' } }],
    ['a status without version', { type: 'status', payload: {} }],
    ['a status without project', { type: 'status', payload: { version: '1' } }],
    ['a status without config', { type: 'status', payload: { version: '1', project: null } }],
    [
      'a status with a step limit over 100',
      {
        type: 'status',
        payload: { version: '1', project: null, config: { ...config, stepLimit: 101 } }
      }
    ],
    [
      'a run_exit in an unknown status',
      {
        type: 'run_exit',
        payload: {
          runId: 'r',
          argv: [],
          status: 'crashed',
          exitCode: null,
          signal: null,
          durationMs: 0,
          output: '',
          truncated: false
        }
      }
    ],
    [
      'a response with an unknown error code',
      { type: 'response', payload: { ok: false, error: { code: 'nope', message: '' } } }
    ],
    ['a response with ok and error', { type: 'response', payload: { ok: true, error: {} } }],
    ['a client-only type', { type: 'auth', payload: { proof } }],
    ['a challenge without a nonce', { type: 'challenge', payload: { proof } }]
  ])('rejects %s', (_label, partial) => {
    expect(
      parseMessage(ServerMessage, raw({ v: PROTOCOL_VERSION, id: '1', ...partial }))
    ).toBeNull();
  });
});

describe('HTTP bodies', () => {
  it('validates pair requests', () => {
    const publicKey = `B${'A'}${'x'.repeat(85)}`;
    expect(PairRequest.safeParse({ code: '012345', publicKey }).success).toBe(true);
    for (const code of ['12345', '1234567', '12a456', ' 123456', 123456]) {
      expect(PairRequest.safeParse({ code, publicKey }).success).toBe(false);
    }
    expect(PairRequest.safeParse({ code: '123456' }).success).toBe(false);
    // Not an uncompressed point: wrong first byte, length or alphabet.
    for (const bad of [`C${'A'.repeat(86)}`, `BA${'x'.repeat(84)}`, `BA${'+'.repeat(85)}`]) {
      expect(PairRequest.safeParse({ code: '123456', publicKey: bad }).success).toBe(false);
    }
    expect(PairRequest.safeParse({ code: '123456', publicKey, extra: true }).success).toBe(false);
  });

  it('validates pair responses', () => {
    const publicKey = `BP${'x'.repeat(85)}`;
    expect(PairSuccess.safeParse({ publicKey, proof: 'a'.repeat(64) }).success).toBe(true);
    // The old response carried a token; it's gone.
    expect(PairSuccess.safeParse({ token: 'a'.repeat(64) }).success).toBe(false);
    expect(PairSuccess.safeParse({ publicKey, proof: 'short' }).success).toBe(false);
    expect(PairFailure.safeParse({ error: 'locked', retryAfterMs: 1000 }).success).toBe(true);
    expect(PairFailure.safeParse({ error: 'not_confirmed' }).success).toBe(true);
    expect(PairFailure.safeParse({ error: 'other' }).success).toBe(false);
  });

  it('validates the unpair proof exchange', () => {
    expect(UnpairChallengeRequest.safeParse({ nonce }).success).toBe(true);
    expect(UnpairChallengeResponse.safeParse({ proof, serverNonce: nonce }).success).toBe(true);
    expect(UnpairRequest.safeParse({ serverNonce: nonce, proof }).success).toBe(true);
    expect(UnpairRequest.safeParse({ token }).success).toBe(false);
    expect(UnpairRequest.safeParse({ serverNonce: nonce, proof, token }).success).toBe(false);
  });

  it('validates health', () => {
    expect(HealthResponse.safeParse({ name: 'bridge', version: '0.1.0' }).success).toBe(true);
    expect(HealthResponse.safeParse({ name: 'other', version: '0.1.0' }).success).toBe(false);
  });
});

describe('proofInput', () => {
  it('separates role, purpose and port', () => {
    const inputs = [
      proofInput('server', 'ws', 1, nonce),
      proofInput('client', 'ws', 1, nonce),
      proofInput('server', 'unpair', 1, nonce),
      proofInput('server', 'ws', 2, nonce)
    ];
    expect(new Set(inputs).size).toBe(inputs.length);
  });
});

describe('candidatePorts', () => {
  it('starts at the default and covers the range', () => {
    const ports = candidatePorts();
    expect(ports[0]).toBe(DEFAULT_PORT);
    expect(ports).toHaveLength(PORT_RANGE);
    expect(ports.at(-1)).toBe(DEFAULT_PORT + PORT_RANGE - 1);
  });
});

describe('candidatePorts for the e2e scripts', () => {
  it('is a separate range of the same size', () => {
    const e2e = candidatePorts(E2E_PORT);
    expect(e2e).toHaveLength(PORT_RANGE);
    expect(e2e.some((port) => candidatePorts().includes(port))).toBe(false);
  });
});

describe('protocol version handshake', () => {
  it('names the older side', () => {
    expect(protocolAdvice(5, 5)).toBeNull();
    expect(protocolAdvice(4, 5)).toBe('update-app');
    expect(protocolAdvice(6, 5)).toBe('update-extension');
  });

  it('reads the version of any hello, and nothing else', () => {
    const hello = (v: unknown, extra = {}) =>
      JSON.stringify({ v, id: 'h', type: 'hello', payload: { nonce }, ...extra });
    expect(helloProtocol(hello(PROTOCOL_VERSION))).toBe(PROTOCOL_VERSION);
    expect(helloProtocol(hello(PROTOCOL_VERSION + 3, { more: true }))).toBe(PROTOCOL_VERSION + 3);
    for (const raw of [hello('5'), hello(0), hello(1.5), '{', 'null', '[]']) {
      expect(helloProtocol(raw)).toBeNull();
    }
    expect(helloProtocol(JSON.stringify({ v: 6, id: 'p', type: 'ping', payload: {} }))).toBeNull();
  });

  it('round-trips the close reason', () => {
    expect(parseMismatchReason(mismatchReason(7))).toBe(7);
    for (const bad of ['', 'protocol', 'protocol x', 'protocol 1234567', ' protocol 5']) {
      expect(parseMismatchReason(bad)).toBeNull();
    }
  });

  it('reads any build’s /health: protocol optional, newer fields ignored', () => {
    expect(HealthResponse.safeParse({ name: 'bridge', version: '0.1.0' }).success).toBe(true);
    expect(
      HealthResponse.parse({ name: 'bridge', version: '2.0.0', protocol: 9, features: [] }).protocol
    ).toBe(9);
    expect(HealthResponse.safeParse({ name: 'other', version: '1' }).success).toBe(false);
  });
});
