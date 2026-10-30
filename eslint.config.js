import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/src-tauri/**',
      '**/node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // Spec-locked isolation (Mode A): the Wavelength SDK is imported in exactly
  // one place — services/wavelength-adapter/src/sdk. Every other package
  // consumes the SDK through @sovereign/wavelength-adapter's re-exported
  // surface, so a single golden-tested edge controls upstream drift.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: ['services/wavelength-adapter/src/sdk/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@lightninglabs/wavelength', '@lightninglabs/wavelength-*', '@lightninglabs/wavelength-*/**'],
              message:
                'Wavelength SDK contact is isolated in services/wavelength-adapter/src/sdk — import the type through @sovereign/wavelength-adapter instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // Plain-Node scripts and test stubs run under Node — give them the Node
    // globals instead of sprinkling /* global */ comments.
    files: ['**/*.mjs', 'scripts/**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
