import { describe, expect, it } from 'vitest';
import { filterEnv, isValidEnvPattern } from './env';

const USER_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/me',
  LANG: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://proxy:3128',
  NODE_ENV: 'development',
  GITHUB_TOKEN: 'ghp_x',
  NPM_TOKEN: 'npm_x',
  GH_TOKEN: 'gho_x',
  SLACK_BOT_TOKEN: 'xoxb',
  my_token_file: '/tmp/t',
  CLIENT_SECRET: 's',
  STRIPE_SECRET_KEY: 'sk',
  API_KEY: 'k',
  SSH_KEY_PATH: '/k',
  KEYCHAIN_NAME: 'login',
  DB_PASSWORD: 'p',
  AWS_ACCESS_KEY_ID: 'a',
  AWS_PROFILE: 'dev',
  aws_region: 'eu-west-1',
  OPENAI_API_KEY: 'o',
  OPENAI_ORG: 'org',
  ELECTRON_RUN_AS_NODE: '1',
  CI: 'false',
  npm_config_auto_install_peers: 'true',
  npm_lifecycle_event: 'dev',
  npm_package_name: 'bridge',
  INIT_CWD: '/Users/me/bridge',
  PNPM_SCRIPT_SRC_DIR: '/Users/me/bridge',
  NPM_CONFIG_REGISTRY: 'https://registry.example.com/',
  force_color: '3',
  '=C:': 'C:\\work',
  UNSET: undefined
};

describe('filterEnv', () => {
  const env = filterEnv(USER_ENV);

  it('keeps what tools need', () => {
    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      NODE_ENV: 'development'
    });
  });

  it.each([
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'GH_TOKEN',
    'SLACK_BOT_TOKEN',
    'my_token_file',
    'CLIENT_SECRET',
    'STRIPE_SECRET_KEY',
    'API_KEY',
    'SSH_KEY_PATH',
    'KEYCHAIN_NAME',
    'DB_PASSWORD',
    'AWS_ACCESS_KEY_ID',
    'AWS_PROFILE',
    'aws_region',
    'OPENAI_API_KEY',
    'OPENAI_ORG',
    'ELECTRON_RUN_AS_NODE',
    '=C:',
    'UNSET'
  ])('drops %s', (name) => {
    expect(env).not.toHaveProperty(name);
  });

  it('drops what the launching package manager set, and keeps the user’s npm config', () => {
    for (const name of [
      'npm_config_auto_install_peers',
      'npm_lifecycle_event',
      'npm_package_name',
      'INIT_CWD',
      'PNPM_SCRIPT_SRC_DIR'
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env.NPM_CONFIG_REGISTRY).toBe('https://registry.example.com/');
  });

  it('sets CI=1 and FORCE_COLOR=0, replacing any spelling of them', () => {
    expect(env.CI).toBe('1');
    expect(env.FORCE_COLOR).toBe('0');
    expect(env).not.toHaveProperty('force_color');
  });

  it('drops the user’s extra patterns too, but never re-allows a default', () => {
    const extra = filterEnv(USER_ENV, ['HTTPS_PROXY', 'NODE_*', '!GITHUB_TOKEN']);
    expect(extra).not.toHaveProperty('HTTPS_PROXY');
    expect(extra).not.toHaveProperty('NODE_ENV');
    expect(extra).not.toHaveProperty('GITHUB_TOKEN');
    expect(extra.PATH).toBe('/usr/bin:/bin');
  });

  it('accepts only variable-name patterns', () => {
    expect(isValidEnvPattern('MY_*')).toBe(true);
    expect(isValidEnvPattern('*')).toBe(false);
    expect(isValidEnvPattern('A B')).toBe(false);
    expect(isValidEnvPattern('!PATH')).toBe(false);
    expect(isValidEnvPattern('.*')).toBe(false);
    expect(isValidEnvPattern('')).toBe(false);
  });
});
