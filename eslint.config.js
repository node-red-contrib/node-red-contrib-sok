import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  Buffer: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  module: 'readonly',
  process: 'readonly',
  require: 'readonly',
  setTimeout: 'readonly'
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'captures/**', 'lib/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'preserve-caught-error': 'off'
    }
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: nodeGlobals
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['bin/**/*.js', 'nodes/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      globals: nodeGlobals
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  }
);
