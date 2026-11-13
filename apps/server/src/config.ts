import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

export const config = {
  // Deliberately not PORT/HOST: dev launchers set those for the web app and the two must not collide.
  port: Number(process.env.API_PORT ?? 4747),
  host: process.env.API_HOST ?? '127.0.0.1',
  dataDir: process.env.DATA_DIR ?? resolve(repoRoot, 'data'),
  webDist: resolve(repoRoot, 'apps/web/dist'),
  userAgent: 'smart-btc/0.1 (local research tool)',
  /** Set SYNC=off to serve only what is already in the local database. */
  syncEnabled: (process.env.SYNC ?? 'on') !== 'off',
};
