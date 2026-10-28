import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../../infrastructure/filesystem/fs.js';

/**
 * Machine-local application data directory (global project registry, and in
 * later milestones the SQLite store, logs and provider profiles).
 *
 * Resolution order:
 *   1. $AW_DATA_DIR
 *   2. $XDG_DATA_HOME/agent-workspace
 *   3. macOS: ~/Library/Application Support/agent-workspace
 *   4. Linux / WSL: ~/.local/share/agent-workspace
 *
 * Never inside a repository, and never synchronized: it holds absolute paths.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const override = env.AW_DATA_DIR?.trim();
  if (override) return path.resolve(expandHome(override));
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'agent-workspace');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'agent-workspace');
  return path.join(home, '.local', 'share', 'agent-workspace');
}
