import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules', '**/dist', '**/out', '**/release', '.pnpm-store', 'archive']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['apps/extension/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.webextensions } }
  },
  {
    // Manual Playwright scripts (e2e/README.md). `chrome` appears inside page callbacks.
    files: ['e2e/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions }
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
);
