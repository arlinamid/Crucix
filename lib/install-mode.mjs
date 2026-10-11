// A copy installed from npm (npx, npm install -g, a dependency) lives under node_modules, which an update or the npx
// cache cleanup replaces: its .env and runs/ belong in the user profile (~/.crucix), never next to the code.

import { sep } from 'node:path';

export function isPackageInstall(root) {
  if (process.env.CRUCIX_PACKAGE_INSTALL === '1') return true;
  return `${String(root)}${sep}`.toLowerCase().includes(`${sep}node_modules${sep}`);
}
