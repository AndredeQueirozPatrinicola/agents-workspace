import { describe, expect, it } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude/claude.js';
import { CodexProvider } from '../src/providers/codex/codex.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import type { AgentLaunchContext } from '../src/providers/types.js';
import { NodeCommandRunner } from '../src/infrastructure/process/runner.js';
import { MockRunner, fakeAgentCli, tempDir } from './helpers.js';

const base: AgentLaunchContext = {
  agentName: 'backend',
  projectName: 'my-saas',
  worktreePath: '/ws/my-saas/backend',
  branch: 'agent/backend',
  promptFile: '/state/agents/backend/prompt.md',
  model: undefined,
  providerArgs: [],
  agentArgs: [],
  resume: false,
  command: undefined,
};

describe('CodexProvider', () => {
  const codex = new CodexProvider(new MockRunner());

  it('starts an interactive session in the worktree with the prompt as the last argument', () => {
    const launch = codex.buildLaunchCommand(base);
    expect(launch.command).toBe('codex');
    expect(launch.cwd).toBe('/ws/my-saas/backend');
    expect(launch.args).toEqual(['--cd', '/ws/my-saas/backend', { fromFile: '/state/agents/backend/prompt.md' }]);
    expect(launch.env).toEqual({
      AW_AGENT: 'backend',
      AW_PROJECT: 'my-saas',
      AW_BRANCH: 'agent/backend',
      AW_WORKTREE: '/ws/my-saas/backend',
    });
  });

  it('passes model and provider/agent arguments in order', () => {
    const launch = codex.buildLaunchCommand({
      ...base,
      model: 'gpt-5-codex',
      providerArgs: ['--sandbox', 'workspace-write'],
      agentArgs: ['--search'],
      command: '/opt/bin/codex',
    });
    expect(launch.command).toBe('/opt/bin/codex');
    expect(launch.args).toEqual([
      '--model',
      'gpt-5-codex',
      '--cd',
      '/ws/my-saas/backend',
      '--sandbox',
      'workspace-write',
      '--search',
      { fromFile: '/state/agents/backend/prompt.md' },
    ]);
  });

  it('resumes the most recent session without resending the prompt', () => {
    const launch = codex.buildLaunchCommand({ ...base, resume: true });
    expect(launch.args).toEqual(['resume', '--last', '--cd', '/ws/my-saas/backend']);
  });

  it('starts without a prompt when none is given', () => {
    expect(codex.buildLaunchCommand({ ...base, promptFile: null }).args).toEqual(['--cd', '/ws/my-saas/backend']);
  });
});

describe('ClaudeProvider', () => {
  const claude = new ClaudeProvider(new MockRunner());

  it('relies on the working directory (no cwd flag) and passes the prompt positionally', () => {
    const launch = claude.buildLaunchCommand({ ...base, model: 'sonnet' });
    expect(launch.command).toBe('claude');
    expect(launch.cwd).toBe('/ws/my-saas/backend');
    expect(launch.args).toEqual(['--model', 'sonnet', { fromFile: '/state/agents/backend/prompt.md' }]);
  });

  it('continues the previous conversation in the worktree on resume', () => {
    const launch = claude.buildLaunchCommand({ ...base, resume: true, agentArgs: ['--permission-mode', 'acceptEdits'] });
    expect(launch.args).toEqual(['--continue', '--permission-mode', 'acceptEdits']);
  });
});

describe('provider detection', () => {
  it('detects installation, version and required flags', async () => {
    const dir = tempDir();
    const good = fakeAgentCli(dir, 'claude', '--model <model> -c, --continue');
    const old = fakeAgentCli(dir, 'oldclaude', '--model only');
    const claude = new ClaudeProvider(new NodeCommandRunner());
    expect(await claude.isInstalled(good.path)).toBe(true);
    expect(await claude.getVersion(good.path)).toBe('9.9.9');
    expect(await claude.probe(good.path)).toMatchObject({ installed: true, version: '9.9.9', missingFlags: [] });
    expect((await claude.probe(old.path)).missingFlags).toEqual(['--continue']);
    expect(await claude.probe('/nonexistent/claude')).toMatchObject({ installed: false, version: null });
  });
});

describe('ProviderRegistry', () => {
  it('lists providers and rejects unknown ids with the available ones', () => {
    const registry = createProviderRegistry(new MockRunner());
    expect(registry.ids()).toEqual(['codex', 'claude']);
    expect(registry.get('claude').displayName).toBe('Claude Code');
    expect(() => registry.get('gemini')).toThrow(/Unknown provider "gemini"/);
  });
});
