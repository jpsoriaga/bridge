import { describe, expect, it } from 'vitest';
import {
  candidatePorts,
  ClientMessage,
  clientMessage,
  DEFAULT_PORT,
  HealthResponse,
  PairFailure,
  PairRequest,
  PairSuccess,
  parseMessage,
  PORT_RANGE,
  ServerMessage,
  serverMessage
} from './protocol';

const token = 'a'.repeat(64);
const raw = (value: unknown) => JSON.stringify(value);

describe('client messages', () => {
  it('accepts auth, ping and pong', () => {
    for (const msg of [
      clientMessage('1', 'auth', { token }),
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
    ['a wrong version', raw({ v: 2, id: '1', type: 'ping', payload: {} })],
    ['a missing id', raw({ v: 1, type: 'ping', payload: {} })],
    ['an empty id', raw({ v: 1, id: '', type: 'ping', payload: {} })],
    ['an overlong id', raw({ v: 1, id: 'x'.repeat(65), type: 'ping', payload: {} })],
    ['a missing payload', raw({ v: 1, id: '1', type: 'ping' })],
    ['extra envelope keys', raw({ v: 1, id: '1', type: 'ping', payload: {}, x: 1 })],
    ['extra payload keys', raw({ v: 1, id: '1', type: 'ping', payload: { x: 1 } })],
    ['a short token', raw({ v: 1, id: '1', type: 'auth', payload: { token: 'abc' } })],
    [
      'an uppercase token',
      raw({ v: 1, id: '1', type: 'auth', payload: { token: 'A'.repeat(64) } })
    ],
    ['a numeric token', raw({ v: 1, id: '1', type: 'auth', payload: { token: 1 } })]
  ])('rejects %s', (_label, input) => {
    expect(parseMessage(ClientMessage, input)).toBeNull();
  });
});

describe('server messages', () => {
  it('accepts every server type', () => {
    for (const msg of [
      serverMessage('1', 'auth_ok', {}),
      serverMessage('2', 'auth_error', { reason: 'invalid_token' }),
      serverMessage('3', 'ping', {}),
      serverMessage('4', 'pong', {}),
      serverMessage('5', 'status', { version: '0.1.0' }),
      serverMessage('6', 'error', { code: 'invalid_message', message: 'Bad message' })
    ]) {
      expect(parseMessage(ServerMessage, raw(msg))).toEqual(msg);
    }
  });

  it.each([
    ['an unknown auth_error reason', { type: 'auth_error', payload: { reason: 'nope' } }],
    ['an unknown error code', { type: 'error', payload: { code: 'x', message: '' } }],
    ['a status without version', { type: 'status', payload: {} }],
    ['a client-only type', { type: 'auth', payload: { token } }]
  ])('rejects %s', (_label, partial) => {
    expect(parseMessage(ServerMessage, raw({ v: 1, id: '1', ...partial }))).toBeNull();
  });
});

describe('HTTP bodies', () => {
  it('validates pair requests', () => {
    expect(PairRequest.safeParse({ code: '012345' }).success).toBe(true);
    for (const code of ['12345', '1234567', '12a456', ' 123456', 123456]) {
      expect(PairRequest.safeParse({ code }).success).toBe(false);
    }
    expect(PairRequest.safeParse({ code: '123456', extra: true }).success).toBe(false);
  });

  it('validates pair responses', () => {
    expect(PairSuccess.safeParse({ token }).success).toBe(true);
    expect(PairSuccess.safeParse({ token: 'short' }).success).toBe(false);
    expect(PairFailure.safeParse({ error: 'locked', retryAfterMs: 1000 }).success).toBe(true);
    expect(PairFailure.safeParse({ error: 'other' }).success).toBe(false);
  });

  it('validates health', () => {
    expect(HealthResponse.safeParse({ name: 'bridge', version: '0.1.0' }).success).toBe(true);
    expect(HealthResponse.safeParse({ name: 'other', version: '0.1.0' }).success).toBe(false);
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
