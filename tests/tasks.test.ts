import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTask, parseTask, renderTaskFile, resolveTaskPath, titleFromObjective } from '../src/core/tasks/task.js';
import { MAX_INLINE_PROMPT_BYTES, buildAgentPrompt, hasActionableTask } from '../src/core/tasks/prompt.js';
import type { ResolvedAgent } from '../src/core/config/loader.js';
import { readTemplate } from '../src/infrastructure/filesystem/package-root.js';
import { tempDir } from './helpers.js';

const authTask = `# Task: Authentication

## Objective

Implement JWT-based authentication.

## Scope

- Login endpoint
- Refresh token flow

## Files

- \`src/auth/**\` — auth module
- src/middleware/auth.ts

## Dependencies

- User schema must be defined.

## Acceptance Criteria

- Unit tests pass.

\`\`\`sh
## not a heading inside a code block
\`\`\`
`;

const agent: ResolvedAgent = {
  name: 'auth',
  provider: 'claude',
  branch: 'agent/auth',
  base: 'main',
  task: 'tasks/auth.md',
  description: undefined,
  model: undefined,
  args: [],
  scope: ['src/auth/**'],
  dependsOn: ['database'],
  configured: true,
};

describe('task parsing', () => {
  it('extracts title, sections and file globs', () => {
    const parsed = parseTask(authTask);
    expect(parsed.title).toBe('Authentication');
    expect(Object.keys(parsed.sections)).toEqual(['Objective', 'Scope', 'Files', 'Dependencies', 'Acceptance Criteria']);
    expect(parsed.sections.Objective).toBe('Implement JWT-based authentication.');
    expect(parsed.files).toEqual(['src/auth/**', 'src/middleware/auth.ts']);
    expect(parsed.sections['Acceptance Criteria']).toContain('## not a heading inside a code block');
    expect(parsed.isTemplate).toBe(false);
  });

  it('detects unedited templates', () => {
    const template = renderTaskFile(readTemplate('task.md'), { agent: 'api', title: 'API' });
    expect(parseTask(template).isTemplate).toBe(true);
    expect(template).toContain('# Task: API');
  });

  it('renders a ready-to-use task from an objective', () => {
    const text = renderTaskFile(readTemplate('task.md'), {
      agent: 'api',
      title: 'Api',
      objective: 'Build the REST API for users. Use express.',
      scope: ['src/api/**'],
    });
    const parsed = parseTask(text);
    expect(parsed.isTemplate).toBe(false);
    expect(parsed.title).toBe('Build the REST API for users');
    expect(parsed.sections.Objective).toBe('Build the REST API for users. Use express.');
    expect(parsed.files).toEqual(['src/api/**']);
  });

  it('derives short titles', () => {
    expect(titleFromObjective('Add RBAC. Then more.')).toBe('Add RBAC');
    expect(titleFromObjective('x'.repeat(100)).length).toBe(72);
  });
});

describe('task loading', () => {
  it('loads task files relative to .agents/ and returns null when missing', async () => {
    const root = tempDir();
    mkdirSync(path.join(root, '.agents', 'tasks'), { recursive: true });
    writeFileSync(path.join(root, '.agents', 'tasks', 'auth.md'), authTask);
    const task = await loadTask(root, 'tasks/auth.md');
    expect(task?.relativePath).toBe('.agents/tasks/auth.md');
    expect(task?.title).toBe('Authentication');
    expect(await loadTask(root, 'tasks/missing.md')).toBeNull();
  });

  it('rejects task paths outside the repository', () => {
    expect(() => resolveTaskPath(tempDir(), '../../etc/passwd')).toThrow(/outside the repository/);
  });
});

describe('agent prompt', () => {
  const task = { path: '/repo/.agents/tasks/auth.md', relativePath: '.agents/tasks/auth.md', content: authTask, ...parseTask(authTask) };

  it('includes isolation rules, scope, other agents, dependencies and the task text', () => {
    const prompt = buildAgentPrompt({
      projectName: 'my-saas',
      agent,
      worktreePath: '/ws/auth',
      task,
      dependencies: [{ name: 'database', branch: 'agent/database', merged: false }],
      otherAgents: [{ name: 'backend', branch: 'agent/backend', scope: ['src/api/**'] }],
      extraInstructions: 'Prefer small commits.',
    });
    expect(prompt).toContain('You are the "auth" agent');
    expect(prompt).toContain('/ws/auth');
    expect(prompt).toContain('Your branch is "agent/auth" (base: "main")');
    expect(prompt).toContain('Do not push');
    expect(prompt).toContain('src/auth/**, src/middleware/auth.ts');
    expect(prompt).toContain('backend on agent/backend (scope: src/api/**)');
    expect(prompt).toContain('database (agent/database): NOT yet merged');
    expect(prompt).toContain('Implement JWT-based authentication.');
    expect(prompt).toContain('Prefer small commits.');
  });

  it('never sends an unedited template, and falls back to a file reference for huge tasks', () => {
    const template = { ...task, isTemplate: true };
    expect(buildAgentPrompt({ projectName: 'p', agent, worktreePath: '/w', task: template, dependencies: [], otherAgents: [] })).not.toContain(
      'Implement JWT',
    );
    const big = { ...task, content: 'x'.repeat(MAX_INLINE_PROMPT_BYTES + 10) };
    const prompt = buildAgentPrompt({ projectName: 'p', agent, worktreePath: '/w', task: big, dependencies: [], otherAgents: [] });
    expect(prompt.length).toBeLessThan(MAX_INLINE_PROMPT_BYTES);
    expect(prompt).toContain('Read it in full: /repo/.agents/tasks/auth.md');
  });

  it('decides whether there is an actionable task', () => {
    expect(hasActionableTask(task, agent)).toBe(true);
    expect(hasActionableTask({ ...task, isTemplate: true }, agent)).toBe(false);
    expect(hasActionableTask({ ...task, isTemplate: true }, agent, 'do X')).toBe(true);
    expect(hasActionableTask(null, agent)).toBe(false);
    expect(hasActionableTask(null, { ...agent, description: 'Build auth' })).toBe(true);
  });
});
