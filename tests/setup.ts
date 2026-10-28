import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Global test isolation:
 *  - Git never reads the user's global/system config and never prompts.
 *  - Commits get a fixed identity without touching any config file.
 *  - tmux commands go to a private server (set per test file via AW_TMUX_SOCKET).
 */
const home = mkdtempSync(path.join(os.tmpdir(), 'aw-test-home-'));
const gitconfig = path.join(home, '.gitconfig');
writeFileSync(gitconfig, '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_AUTHOR_NAME = 'AW Test';
process.env.GIT_AUTHOR_EMAIL = 'aw-test@example.com';
process.env.GIT_COMMITTER_NAME = 'AW Test';
process.env.GIT_COMMITTER_EMAIL = 'aw-test@example.com';
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.NO_COLOR = '1';
delete process.env.TMUX;
delete process.env.AW_WORKSPACE_DIR;
