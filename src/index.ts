#!/usr/bin/env node
import { runCli } from './cli/run.js';
import { ExitCode } from './core/errors.js';

// Writing to a closed pipe (e.g. `aw status | head -1`) must not crash a
// command half-way through; drop the output instead.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

process.on('SIGINT', () => {
  process.exit(ExitCode.ABORTED);
});

runCli(process.argv).then((code) => {
  process.exitCode = code;
});
