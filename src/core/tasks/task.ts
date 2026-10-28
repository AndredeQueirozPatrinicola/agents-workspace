import path from 'node:path';
import { AwError, ExitCode } from '../errors.js';
import { isPathInside, readTextIfExists } from '../../infrastructure/filesystem/fs.js';
import { CONFIG_DIR } from '../config/loader.js';

/**
 * Markdown task files (`.agents/tasks/<agent>.md`).
 *
 * Task files are plain, human-editable Markdown. We extract only a little
 * structure (title, sections, file globs) for prompts and safety checks; the
 * full text is passed to the agent unchanged.
 */

/** Marker present in freshly generated templates; remove it once the task is written. */
export const TEMPLATE_MARKER = '<!-- aw:template';

export interface TaskFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the configuration root (for display and prompts). */
  relativePath: string;
  content: string;
  title: string | null;
  sections: Record<string, string>;
  /** File globs listed under a "Files"/"Allowed Files"/"Preferred Files" section. */
  files: string[];
  /** True when the file is still an unedited template. */
  isTemplate: boolean;
}

export function resolveTaskPath(configRoot: string, task: string): string {
  const base = path.join(configRoot, CONFIG_DIR);
  const resolved = path.resolve(base, task);
  if (!isPathInside(resolved, configRoot)) {
    throw new AwError(`Task path "${task}" points outside the repository.`, {
      exitCode: ExitCode.USAGE,
      hint: 'Task paths are relative to .agents/ and must stay inside the repository.',
    });
  }
  return resolved;
}

export function parseTask(content: string): Pick<TaskFile, 'title' | 'sections' | 'files' | 'isTemplate'> {
  const lines = content.split(/\r?\n/);
  let title: string | null = null;
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current !== null) sections[current] = buffer.join('\n').trim();
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const h1 = /^#\s+(.+?)\s*#*$/.exec(line);
      if (h1 && title === null) {
        title = (h1[1] ?? '').replace(/^task:\s*/i, '').trim();
        continue;
      }
      const h2 = /^##\s+(.+?)\s*#*$/.exec(line);
      if (h2) {
        flush();
        current = (h2[1] ?? '').trim();
        buffer = [];
        continue;
      }
    }
    if (current !== null) buffer.push(line);
  }
  flush();

  const files: string[] = [];
  for (const [name, body] of Object.entries(sections)) {
    if (!/^(allowed |preferred |owned )?files( and directories)?$|^file scope$/i.test(name)) continue;
    for (const line of body.split('\n')) {
      const item = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (!item) continue;
      const code = /`([^`]+)`/.exec(item[1] ?? '');
      const value = (code ? code[1] : (item[1] ?? '').split(/\s+(?:-|—|–)\s+/)[0])?.trim();
      if (value) files.push(value);
    }
  }
  return { title, sections, files, isTemplate: content.includes(TEMPLATE_MARKER) };
}

export async function loadTask(configRoot: string, task: string): Promise<TaskFile | null> {
  const file = resolveTaskPath(configRoot, task);
  const content = await readTextIfExists(file);
  if (content === null) return null;
  return {
    path: file,
    relativePath: path.relative(configRoot, file).split(path.sep).join('/'),
    content,
    ...parseTask(content),
  };
}

/** Derive a short task title from an objective sentence. */
export function titleFromObjective(objective: string, max = 72): string {
  const first = objective.trim().split(/\r?\n/)[0]?.split(/(?<=[.!?])\s/)[0]?.replace(/[.!?]+$/, '') ?? '';
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * Render a new task file.
 *  - Without an objective: the full template (with the template marker, so no
 *    prompt is sent until a human fills it in).
 *  - With an objective (`--task "..."`): a short, ready-to-use task.
 */
export function renderTaskFile(
  template: string,
  vars: { agent: string; title: string; objective?: string | undefined; scope?: string[] | undefined },
): string {
  if (!vars.objective?.trim()) {
    return template.replaceAll('{{agent}}', vars.agent).replaceAll('{{title}}', vars.title);
  }
  const title = titleFromObjective(vars.objective) || vars.title;
  const lines = [`# Task: ${title}`, '', '## Objective', '', vars.objective.trim(), ''];
  if (vars.scope?.length) lines.push('## Files', '', ...vars.scope.map((g) => `- \`${g}\``), '');
  lines.push(
    '## Acceptance Criteria',
    '',
    '- The objective above is implemented and covered by tests.',
    '- Existing tests and checks pass.',
    '- No secrets are committed.',
    '',
  );
  return lines.join('\n');
}
