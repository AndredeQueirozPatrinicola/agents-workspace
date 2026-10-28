// Ensure the CLI entry point is executable after compilation (no-op on Windows).
import { chmodSync, existsSync } from 'node:fs';

const entry = new URL('../dist/index.js', import.meta.url);
if (existsSync(entry)) {
  try {
    chmodSync(entry, 0o755);
  } catch {
    // Non-POSIX filesystems may not support chmod; npm link sets the bit anyway.
  }
}
