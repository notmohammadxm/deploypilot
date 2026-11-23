import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off'
    }
  }
];
