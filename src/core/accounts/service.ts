import { AwError, ExitCode } from '../errors.js';
import type { Deps } from '../deps.js';
import type { WorkspaceConfig } from '../config/schema.js';
import { type Account, accountAllowed, loadSettings, resolveAccounts, validateSettings } from './settings.js';
import { AccountMarks } from './state.js';
import type { RouterContext } from '../routing/router.js';
import { pathExists } from '../../infrastructure/filesystem/fs.js';

/** Accounts, their availability marks and the router context for a project. */
export class AccountService {
  readonly marks: AccountMarks;
  constructor(private readonly deps: Pick<Deps, 'dataDir' | 'providers'>) {
    this.marks = new AccountMarks(deps.dataDir);
  }

  async accounts(): Promise<Account[]> {
    const settings = await loadSettings(this.deps.dataDir);
    return resolveAccounts(settings, this.deps.providers.ids());
  }

  async context(config: Pick<WorkspaceConfig, 'accounts' | 'defaults'> | null): Promise<RouterContext> {
    const settings = await loadSettings(this.deps.dataDir);
    const problems = validateSettings(settings, this.deps.providers.ids());
    if (problems.length) {
      throw new AwError('Invalid user settings (settings.yaml).', { exitCode: ExitCode.USAGE, details: problems, hint: 'Fix them with: aw accounts edit' });
    }
    return {
      settings,
      accounts: resolveAccounts(settings, this.deps.providers.ids()),
      marks: await this.marks.load(),
      policy: config?.accounts ?? null,
      defaultProvider: config?.defaults.provider ?? 'codex',
    };
  }

  async require(name: string): Promise<Account> {
    const account = (await this.accounts()).find((a) => a.name === name);
    if (!account) {
      throw new AwError(`Unknown account "${name}".`, { exitCode: ExitCode.USAGE, hint: 'List accounts with "aw accounts"; add one with "aw accounts add".' });
    }
    return account;
  }

  /** Resolve an account for a launch, enforcing the project policy. */
  async forLaunch(name: string, config: Pick<WorkspaceConfig, 'accounts'>): Promise<Account> {
    const account = await this.require(name);
    if (!accountAllowed(account, config.accounts)) {
      throw new AwError(`Account "${name}" is not allowed in this project.`, {
        exitCode: ExitCode.UNSAFE,
        hint: `Allowed: ${config.accounts?.join(', ')} (accounts: in .agents/workspace.yaml).`,
      });
    }
    if (account.home && !(await pathExists(account.home))) {
      throw new AwError(`The configuration directory of account "${name}" does not exist: ${account.home}`, {
        exitCode: ExitCode.PREREQUISITE,
        hint: `Log in once with: aw accounts login ${name}`,
      });
    }
    return account;
  }
}
