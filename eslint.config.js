import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/', 'migration/', 'index/.cache/', 'data/'] },
  // Legacy is linted the way it was in 2016: ES5, CommonJS, recommended rules only.
  {
    files: ['legacy/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2015, sourceType: 'commonjs', globals: globals.node },
    // Newer than the code. `var fee = 0; if (days > 14) fee = 0;` stays as written.
    rules: { 'no-useless-assignment': 'off' },
  },
  {
    files: ['hooks/**/*.mjs', 'scripts/**/*.mjs', '*.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
