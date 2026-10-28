import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { AwError, ExitCode } from '../errors.js';
import type { Deps } from '../deps.js';
import type { AgentProvider } from '../../providers/types.js';
import { MAX_TASKS, PLAN_JSON_SCHEMA, type Plan, type PlanCheck, checkPlan, planSchema } from './plan.js';
import { ensureDir, readTextIfExists } from '../../infrastructure/filesystem/fs.js';

/**
 * The planner: an agent CLI running once, read-only, in the main checkout,
 * answering with a plan that matches PLAN_JSON_SCHEMA.
 */

export interface PlannerInput {
  projectName: string;
  baseBranch: string;
  request: string;
  /** Feedback on previous plans (re-planning), oldest first. */
  feedback: string[];
  previousPlan: Plan | null;
  providers: string[];
}

export function buildPlannerPrompt(input: PlannerInput): string {
  const lines = [
    `You are the planner of Agent Workspace for the project "${input.projectName}". You run read-only: do not modify any file.`,
    '',
    'A developer described a feature in natural language (below). Your job:',
    '1. Read the repository to understand the real work: the code it touches, conventions (AGENTS.md, CLAUDE.md, README, existing tests), and every file or path the request mentions.',
    '2. Decide how to execute it with coding agents that each work in their own Git worktree and branch, in parallel when possible.',
    '3. Answer with a plan that matches the required JSON schema exactly.',
    '',
    'Rules for a good plan:',
    `- PARALLELIZE ONLY WHEN IT PAYS. A cohesive feature should be ONE task. Split only into parts that are genuinely independent (different files/areas) or that have a clear contract between them. Typical plans have 1 to 4 tasks; never more than ${MAX_TASKS}.`,
    '- Tasks that run at the same time must not edit the same files. Give hot files (route registration, package manifests, shared types) to a single task, or put that task first and make others depend on it.',
    '- Use dependsOn for real ordering constraints only. A dependent task starts after its dependencies are merged into the feature branch, so it sees their code.',
    '- Each task must be completable and verifiable on its own: objective (the outcome), context (files, conventions, contracts, decisions the agent needs), scope globs, acceptance criteria, and exact validation commands that exist in this repository (test, lint, typecheck). Do not invent commands.',
    '- Rate complexity (amount and difficulty of work) and risk (high for auth, payments, data migrations, security, public APIs/contracts) honestly; explain the rating in rationale. These ratings choose the model and effort, so do not inflate them.',
    `- suggestedProvider: "codex", "claude" or "any" (available here: ${input.providers.join(', ')}). suggestedEffort: low for mechanical changes, medium for normal work, high for tricky logic, xhigh/max only for exceptionally hard problems.`,
    '- Put real open questions (ambiguities that change the implementation) in questions. Do not ask about things you can find in the code. Prefer reasonable assumptions, stated in the task context.',
    `- Work happens on a feature branch created from "${input.baseBranch}".`,
    '',
    'The developer\'s request:',
    '-----',
    input.request.trim(),
    '-----',
  ];
  if (input.previousPlan) {
    lines.push('', 'Your previous plan (JSON):', JSON.stringify(input.previousPlan));
  }
  if (input.feedback.length) {
    lines.push('', 'Feedback from the developer on the previous plan(s), oldest first. Revise the plan accordingly:');
    for (const f of input.feedback) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}

export interface PlannerRun {
  provider: AgentProvider;
  cwd: string;
  workDir: string;
  prompt: string;
  model: string | null;
  effort: string | undefined;
  accountHome: string | null;
  command: string | undefined;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface PlannerResult {
  plan: Plan;
  check: PlanCheck;
}

export async function runPlanner(deps: Pick<Deps, 'runner'>, run: PlannerRun): Promise<PlannerResult> {
  await ensureDir(run.workDir);
  const exec = run.provider.buildExecCommand({
    cwd: run.cwd,
    prompt: run.prompt,
    schema: PLAN_JSON_SCHEMA,
    workDir: run.workDir,
    model: run.model,
    effort: run.effort as never,
    accountHome: run.accountHome,
    command: run.command,
  });
  for (const [file, content] of Object.entries(exec.files)) await fsp.writeFile(file, content, 'utf8');
  if (exec.outputFile) await fsp.rm(exec.outputFile, { force: true });
  const result = await deps.runner.run(exec.command, exec.args, {
    cwd: exec.cwd,
    env: { ...run.env, ...exec.env },
    input: exec.input,
    timeoutMs: run.timeoutMs ?? 30 * 60_000,
  });
  await fsp.writeFile(path.join(run.workDir, 'output.log'), `$ ${exec.command} ${exec.args.join(' ')}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`, 'utf8');
  if (result.exitCode !== 0) {
    throw new AwError(`The planner (${run.provider.displayName}) exited with code ${result.exitCode}.`, {
      details: (result.stderr || result.stdout).trim().split('\n').slice(-5),
      hint: `Full output: ${path.join(run.workDir, 'output.log')}`,
    });
  }
  const outputFile = exec.outputFile ? await readTextIfExists(exec.outputFile) : null;
  let raw: unknown;
  try {
    raw = run.provider.parseExecResult(result.stdout, outputFile);
  } catch (error) {
    throw new AwError(`The planner returned no usable JSON: ${error instanceof Error ? error.message : String(error)}`, {
      hint: `Full output: ${path.join(run.workDir, 'output.log')}`,
    });
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AwError('The planner returned a plan that does not match the schema.', {
      exitCode: ExitCode.ERROR,
      details: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      hint: 'Re-plan (it usually succeeds the second time) or choose another planner.',
    });
  }
  const check = checkPlan(parsed.data);
  if (check.errors.length) {
    throw new AwError('The planner returned an inconsistent plan.', { details: check.errors, hint: 'Re-plan with feedback, e.g. "task ids must be unique".' });
  }
  return { plan: parsed.data, check };
}
