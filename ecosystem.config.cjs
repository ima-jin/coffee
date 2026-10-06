// pm2 ecosystem for the standalone ima-jin/coffee app (refs imajin-ai#2498).
//
// One file, two entries: `prod-coffee` (7100) and `dev-coffee` (3100) — the
// same names and ports the kernel monorepo's ecosystem files used, so the
// Caddy route is untouched. Each server checks the repo out once per
// environment (~/prod/coffee, ~/dev/coffee) and starts only its own entry:
//
//   pm2 startOrReload ecosystem.config.cjs --only prod-coffee --update-env
//
// scripts/deploy.sh does exactly that; see docs/DEPLOY.md.
//
// Follows the ima-jin/links ecosystem.config.cjs precedent (imajin-ai#2490):
//   - pm2 execs the Next listener directly (imajin-ai#2447). Never
//     `script: "npm"` / `args: "start"`: pm2 would track the npm wrapper, and
//     on restart the `next-server` grandchild survives, keeps the port bound,
//     and the fresh copy crash-loops on EADDRINUSE.
//   - The env file is loaded with Node's --env-file so the process env is a
//     property of this config, not of whoever ran the last restart. Node EXITS
//     if the file is missing — deliberate: a coffee that cannot load its env
//     must crash loudly, not boot without its identity. Secrets stay in the
//     untracked .env.local; only its path is versioned.
//   - `cwd` is this file's own directory, so the config is correct wherever
//     the checkout lives and never hard-codes a user's home directory.
const path = require('node:path');
const os = require('node:os');

const root = __dirname;
const logDir = path.join(os.homedir(), '.pm2', 'logs');

function coffeeApp(name, port) {
  return {
    name,
    cwd: root,
    script: 'node_modules/next/dist/bin/next',
    args: `start -p ${port}`,
    interpreter: 'node',
    node_args: `--env-file=${path.join(root, '.env.local')}`,
    exec_mode: 'fork',
    env: {
      PORT: port,
      NODE_ENV: 'production',
    },
    out_file: path.join(logDir, `${name}-out.log`),
    error_file: path.join(logDir, `${name}-error.log`),
    time: true,
    max_restarts: 10,
    min_uptime: '20s',
  };
}

module.exports = {
  apps: [coffeeApp('prod-coffee', 7100), coffeeApp('dev-coffee', 3100)],
};
