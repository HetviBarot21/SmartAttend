/**
 * Babel is only used by Jest here - Vite/Rolldown transforms JSX itself, so the
 * presets are scoped to `env.test` (babel-jest sets BABEL_ENV=test) and the
 * production build sees an empty config.
 */
module.exports = {
  env: {
    test: {
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        ['@babel/preset-react', { runtime: 'automatic' }]
      ]
    }
  }
};
