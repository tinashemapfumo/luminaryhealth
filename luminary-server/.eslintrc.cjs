/**
 * Lint for the API.
 *
 * `npm run lint` has been in package.json since the first version with nothing
 * behind it — no eslint, no config — so the command failed on a missing binary
 * and the server had no lint gate at all while the frontend had a strict one.
 *
 * Deliberately narrow. Type errors are `tsc`'s job and are already gated by
 * `npm run typecheck`; this catches the things a type checker does not — an
 * unawaited promise in a route handler, a caught error thrown away, a variable
 * left behind by a refactor. Rules that would only argue about formatting are
 * left out, because a lint run nobody can pass gets disabled rather than fixed.
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    // A dropped promise in a route handler is a request that answers before
    // its own database work has finished. This is the rule worth having here.
    '@typescript-eslint/no-floating-promises': 'error',
    // `checksVoidReturn` is off for properties and arguments because Fastify is
    // built around async handlers: `{ handler: async (req) => ... }` is the
    // documented shape, and flagging it produced 60-odd errors that were all
    // the framework working as designed. Left on for returns, where a promise
    // going missing is a real defect rather than an idiom.
    '@typescript-eslint/no-misused-promises': [
      'error',
      { checksVoidReturn: { properties: false, arguments: false } },
    ],
    // Underscore prefix means "deliberately unused" — the reply parameter a
    // preHandler must accept and never touches, and destructured rest siblings.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    'no-console': 'off',
  },
  ignorePatterns: ['dist/', 'node_modules/'],
};
