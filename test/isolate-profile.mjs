// Preloaded by `npm test` (--import): every test process gets its own empty profile, so nothing a test saves (.env,
// feeds.json, runs/) can reach the operator's real ~/.crucix.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'crucix-test-home-'));
process.env.CRUCIX_HOME = home;
delete process.env.CRUCIX_ENV_FILE;
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* left for the OS temp cleanup */ } });
