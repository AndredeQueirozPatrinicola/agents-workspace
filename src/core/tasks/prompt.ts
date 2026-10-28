import type { ResolvedAgent } from '../config/loader.js';
import type { TaskFile } from './task.js';

/**
 * Initial prompt given to a newly spawned agent.
 *
 * The prompt deliberately does not duplicate repository conventions: agents
 * already read AGENTS.md / CLAUDE.md from their worktree. It only adds what
 * is specific to multi-agent work (isolation, branch, scope, integration
 * rules) plus the human-written task file.
 */

/** Linux limits a single argv string to 128 KiB; stay well below it. */
export const MAX_INLINE_PROMPT_BYTES = 96 * 1024;

export interface PromptInput {
  projectName: string;
  agent: ResolvedAgent;
  worktreePath: string;
  task: TaskFile | null;
  dependencies: Array<{ name: string; branch: string; merged: boolean }>;
  otherAgents: Array<{ name: string; branch: string; scope: string[] }>;
  extraInstructions?: string | undefined;
  /** Shared files area (outside the repository). */
  files?: { inbox: string; agentInbox: string; outbox: string; inputs: string[] } | undefined;
}

export function buildAgentPrompt(input: PromptInput): string {
  const { agent } = input;
  const lines: string[] = [];
  lines.push(
    `You are the "${agent.name}" agent in a multi-agent Agent Workspace session for project "${input.projectName}".`,
    '',
    'Working environment:',
    `- You are in an isolated Git worktree: ${input.worktreePath}`,
    `- Your branch is "${agent.branch}" (base: "${agent.base}"). Commit your work to this branch with clear messages.`,
    '- Other agents are working in parallel on other branches. Stay within your task scope; avoid unrelated refactors, renames or repository-wide formatting changes.',
    '- Do not push, open or merge pull requests, rebase onto other agents\' branches, or rewrite history. The human integrates your work (`aw pr`).',
    '- Never commit secrets, credentials, .env files or local runtime files.',
    '- Follow the repository conventions in AGENTS.md / CLAUDE.md when present.',
  );
  const scope = [...new Set([...agent.scope, ...(input.task?.files ?? [])])];
  if (scope.length) lines.push(`- Your expected file scope: ${scope.join(', ')}. Ask before changing files outside it.`);
  if (input.otherAgents.length) {
    lines.push('- Parallel agents (avoid editing their areas):');
    for (const other of input.otherAgents) {
      lines.push(`  - ${other.name} on ${other.branch}${other.scope.length ? ` (scope: ${other.scope.join(', ')})` : ''}`);
    }
  }
  if (input.dependencies.length) {
    lines.push('', 'Dependencies:');
    for (const dep of input.dependencies) {
      lines.push(
        `- ${dep.name} (${dep.branch}): ${dep.merged ? `merged into ${agent.base}` : `NOT yet merged into ${agent.base}. Code against the agreed contract and do not duplicate that agent's work; report if the contract is missing.`}`,
      );
    }
  }
  if (input.files) {
    const f = input.files;
    lines.push(
      '',
      'Files outside the repository (shared files area):',
      `- Inputs from the human (specs, designs, data, screenshots) are in ${f.agentInbox} (for you) and ${f.inbox} (for all agents). Read them when relevant; do not copy them into the repository unless the task says so.`,
      `- Put non-code deliverables (reports, analyses, exports, screenshots) in ${f.outbox}. Code and anything the project needs belongs in commits on your branch.`,
    );
    if (f.inputs.length) {
      lines.push('- Input files provided for this task:');
      for (const file of f.inputs) lines.push(`  - ${file}`);
    }
  }
  if (input.task && !input.task.isTemplate) {
    lines.push('', `Your task (from ${input.task.relativePath}):`, '', '-----', input.task.content.trim(), '-----');
  } else if (agent.description) {
    lines.push('', `Your task: ${agent.description}`);
  }
  if (input.extraInstructions?.trim()) {
    lines.push('', 'Additional instructions:', input.extraInstructions.trim());
  }
  lines.push('', 'Begin by briefly outlining your plan, then implement it. Run the validation commands from the task before reporting completion.');
  const prompt = lines.join('\n');

  if (Buffer.byteLength(prompt, 'utf8') > MAX_INLINE_PROMPT_BYTES && input.task) {
    // Too large to pass as a single argument: point the agent at the file instead.
    return buildAgentPrompt({
      ...input,
      task: { ...input.task, content: `(The task file is large. Read it in full: ${input.task.path})` },
    });
  }
  return prompt;
}

/** True when there is meaningful task content to send as an initial prompt. */
export function hasActionableTask(task: TaskFile | null, agent: ResolvedAgent, extra?: string): boolean {
  if (extra?.trim()) return true;
  if (task && !task.isTemplate && task.content.trim().length > 0) return true;
  return !task && Boolean(agent.description);
}
