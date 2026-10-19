import { describe, expect, it } from 'vitest';
import { buildContextMessage, buildFollowUp, formatRunResult } from './prompts';
import { entropy, looksRandom, REDACTED, redactSecrets } from './redact';

// Fake credentials, assembled at runtime so the repository never holds a string a secret
// scanner would flag. None of them is real.
const rand = 'Q7f2Kp9xZ3mW8vR1tY6uN4bL0cJ5hG2d';
const fake = {
  openai: `sk-${'proj-'}${rand}`,
  anthropic: `sk-${'ant-api03-'}${rand}`,
  ghp: `gh${'p_'}${rand}abcd`,
  gho: `gh${'o_'}${rand}abcd`,
  pat: `github${'_pat_'}11ABCDEFG0${rand}`,
  aws: `AKI${'A'}IOSFODNN7EXAMPLE`,
  slack: `xox${'b'}-1234567890-0987654321-${rand.slice(0, 24)}`,
  jwt: `eyJ${'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${rand}`,
  pem: [
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA' + rand,
    '-----END RSA PRIVATE KEY-----'
  ].join('\n')
};

describe('redactSecrets', () => {
  it.each(Object.entries(fake))('replaces a %s token', (_name, secret) => {
    const { text, count } = redactSecrets(`before ${secret} after`);
    expect(text).toBe(`before ${REDACTED} after`);
    expect(count).toBe(1);
  });

  it('replaces an unterminated private key to the end', () => {
    const cut = `key:\n-----BEGIN ${'PRIVATE KEY'}-----\nMIIEvQIBADANBgkq${rand}`;
    expect(redactSecrets(cut).text).toBe(`key:\n${REDACTED}`);
  });

  it.each([
    [`API_KEY=${rand}`, `API_KEY=${REDACTED}`],
    [`"apiKey": "${rand}"`, `"apiKey": "${REDACTED}"`],
    [`stripe_secret: '${rand}'`, `stripe_secret: '${REDACTED}'`],
    [`DB_PASSWORD = ${rand}`, `DB_PASSWORD = ${REDACTED}`],
    [`export AUTH_TOKEN=${rand}`, `export AUTH_TOKEN=${REDACTED}`],
    [`Authorization: Bearer ${rand}`, `Authorization: Bearer ${REDACTED}`]
  ])('replaces a random value next to a key word: %s', (input, output) => {
    expect(redactSecrets(input)).toEqual({ text: output, count: 1 });
  });

  it.each([
    'token: string;',
    'const key = "value";',
    'apiKey: process.env.API_KEY,',
    'secret = config.auth.clientSecret',
    'SECRET_NAME=MY_APP_SECRET_NAME',
    'password: "correct horse battery"',
    'keywords: ["a", "b"]',
    'sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'id: 3f1e2c4a-9b7d-4e6f-8a2b-1c3d5e7f9a0b',
    'author: Jane Doe <jane@example.com>',
    'tokenizer.encode("hello world")',
    'Token count: 12345678901234567',
    'skip-navigation and sk-short',
    'ghp_short',
    'Bearer realm="example"',
    '✓ src/keys.test.ts (12 tests) 34ms',
    'eyJ alone is not a token'
  ])('leaves ordinary text alone: %s', (input) => {
    expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
  });

  it('counts every secret in a longer text', () => {
    const text = `a ${fake.ghp}\nb ${fake.aws}\nAPI_KEY=${rand}\n${fake.pem}\n`;
    expect(redactSecrets(text).count).toBe(4);
    expect(redactSecrets(text).text).not.toMatch(/AKIA|ghp_|BEGIN/);
  });

  it('scores entropy and randomness as expected', () => {
    expect(entropy('aaaa')).toBe(0);
    expect(entropy('abcd')).toBe(2);
    expect(looksRandom(rand)).toBe(true);
    expect(looksRandom('aaaaaaaaaaaaaaaa1')).toBe(false);
    expect(looksRandom('process.env.API_KEY1')).toBe(false);
  });
});

describe('redaction in what Bridge sends to the chat', () => {
  const result = {
    argv: ['pnpm', 'test'],
    status: 'exited' as const,
    exitCode: 1,
    signal: null,
    durationMs: 1000
  };

  it('redacts command output before cutting it to size', () => {
    const output = `${'x\n'.repeat(5000)}leaked ${fake.ghp}\n`;
    const built = formatRunResult({ ...result, output }, 500);
    expect(built.redacted).toBe(1);
    expect(built.text).toContain(REDACTED);
    expect(built.text).not.toContain('ghp_');
  });

  it('redacts file contents and counts across files', () => {
    const built = buildContextMessage([
      { path: '.npmrc.example', content: `//registry.npmjs.org/:_authToken=${rand}\n` },
      { path: 'a.ts', content: `const jwt = '${fake.jwt}';\n` }
    ]);
    expect(built.redacted).toBe(2);
    expect(built.text).not.toContain(rand);
  });

  it('counts redactions in a Full auto follow-up, which still gets built', () => {
    const built = buildFollowUp({
      applied: [],
      skipped: [],
      files: [{ path: 'a.env.example', content: `API_KEY=${rand}\n` }],
      refused: [],
      runs: [{ command: 'pnpm test', result: { ...result, output: `token=${fake.slack}` } }]
    });
    expect(built?.redacted).toBe(2);
    expect(built?.text).not.toContain(rand);
  });
});
