import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-electron',
      'node_modules',
      'mock-repositories',
      'mock-workspace',
      'cypress/videos',
      'cypress/screenshots',
      '.cache',
      '.pnpm-store',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Node/main-process context: Electron main, build/test scripts, root config files.
  {
    files: [
      'electron/**/*.ts',
      'scripts/**/*.{js,mjs,cjs}',
      'cypress/**/*.ts',
      '*.{ts,mts,cts,js,mjs,cjs}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Renderer (browser) context: React UI.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // CommonJS Electron/test helpers — allow require() and module globals.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Cypress specs use chai expression-style assertions and namespace augmentation.
  {
    files: ['cypress/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  // Existing code was never linted — keep these as warnings, not blockers.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Disable stylistic rules that conflict with Prettier (must come last).
  prettier,
);
