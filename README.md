# Agent Workspace (`aw`)

A local-first CLI for running several AI coding agents (OpenAI Codex CLI, Anthropic Claude Code) **in parallel on the same Git repository** without them stepping on each other.

Each agent gets its own Git worktree, branch, tmux session, task brief and runtime metadata. You get one place to start, watch, attach to, stop, review and publish all of them.

```sh
cd ~/projects/my-saas
aw init

aw spawn database --provider claude --task "Model orgs, users, roles and projects with migrations"
aw spawn backend  --provider codex  --task "CRUD API for users and projects"
aw spawn auth     --provider claude --task "JWT login with refresh-token rotation"

aw dashboard        # tmux grid of every running agent
aw check            # overlaps, stale branches, simulated merge conflicts
aw pr backend       # push + draft PR, after confirmation
```

No cloud service, no daemon, no database, no custom IDE. `aw` orchestrates tools you already use: `git`, `tmux`, `gh`, `codex`, `claude`.

**Roadmap:** Agent Workspace is evolving into an integrated environment: describe a feature, review a plan, and watch agents execute it in parallel. See [ADR 0001](docs/adr/0001-integrated-environment.md). Milestone 1 (the dashboard and project registry) is done.

**New here? Read [`docs/daily-workflow.md`](docs/daily-workflow.md)**: the daily loop, dashboard keys, recovering an agent that quit, writing good task files, and handling conflicts.

---

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Prerequisites and supported platforms](#prerequisites-and-supported-platforms)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The dashboard (`aw`)](#the-dashboard-aw)
- [Command reference](#command-reference)
- [Configuration reference](#configuration-reference)
- [Task files and agent context](#task-files-and-agent-context)
- [Git worktrees in Agent Workspace](#git-worktrees-in-agent-workspace)
- [Codex and Claude Code integration](#codex-and-claude-code-integration)
- [tmux sessions and the dashboard](#tmux-sessions-and-the-dashboard)
- [GitHub integration](#github-integration)
- [Parallel development safety](#parallel-development-safety)
- [Working across machines](#working-across-machines)
- [Example: building a SaaS with five agents](#example-building-a-saas-with-five-agents)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Security considerations](#security-considerations)
- [Development](#development)

---

## Why

Running two or three coding agents at once is easy. Running them **in the same repository** is not:

- they edit the same files and overwrite each other,
- they fight over the checked-out branch,
- you lose track of which terminal is doing what,
- setting everything up again on another machine is tedious,
- commits, PRs and review happen ad hoc.

Agent Workspace makes parallel agents safe and observable: isolation through worktrees, persistence through tmux, coordination through versioned task files, and deliberate integration through pull requests.

## How it works

```
~/projects/
├── my-saas/                         # your repository (main worktree)
│   ├── .agents/
│   │   ├── workspace.yaml           # versioned project + agent config
│   │   └── tasks/*.md               # one human-written brief per agent
│   └── .git/agent-workspace/        # machine-local runtime state (never committed)
└── .agent-workspace/
    └── my-saas/
        ├── database/                # worktree on feat/database  ← tmux: aw-my-saas-1a2b3c-database
        ├── backend/                 # worktree on feat/backend   ← tmux: aw-my-saas-1a2b3c-backend
        └── auth/                    # worktree on feat/auth      ← tmux: aw-my-saas-1a2b3c-auth
```

Agent lifecycle:

```
aw add ──► aw spawn ──► (aw attach | aw dashboard) ──► aw stop ──► aw spawn --resume
               │                                                        │
               └──────────────► agent commits on its branch ◄───────────┘
                                         │
                           aw check ──► aw pr ──► review & merge on GitHub ──► aw cleanup
```

- **spawn** creates (or reuses) the worktree and branch, renders the task into a prompt, writes a small launcher script into `.git/agent-workspace/`, and starts the agent CLI inside a dedicated tmux session.
- **stop** ends the tmux session. The worktree, branch and commits stay.
- **cleanup** removes a *clean* worktree. It never deletes uncommitted work and never deletes unmerged branches.

## Prerequisites and supported platforms

| Tool | Version | Needed for |
|------|---------|------------|
| Node.js | 20.11+ (22 LTS recommended; 22.12+ to run the test suite) | running `aw` |
| Git | 2.31+ (2.38+ recommended) | worktrees; 2.38 enables conflict simulation in `aw check` |
| tmux | 3.0+ | agent sessions and dashboard |
| GitHub CLI (`gh`) | any recent | `aw pr` (optional otherwise) |
| Codex CLI and/or Claude Code | see [provider notes](#codex-and-claude-code-integration) | the agents themselves |

| Platform | Status |
|----------|--------|
| Ubuntu / Debian Linux | Supported |
| macOS (Apple silicon & Intel) | Supported |
| Windows via **WSL2** (Ubuntu) | Supported — the recommended way on Windows |
| Native Windows (PowerShell/cmd) | Not supported (no tmux); `aw doctor` says so |

`aw doctor` checks all of the above and tells you what is missing.

## Installation

```sh
git clone <repository-url> agent-workspace
cd agent-workspace
npm install
npm run build
npm link          # puts `aw` on your PATH

aw doctor
```

`npm link` may need `sudo` if your global npm prefix is system-owned; prefer a user-level prefix (`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`) or a Node version manager (nvm, fnm, volta). To uninstall: `npm unlink -g agent-workspace`.

### Ubuntu / Debian

```sh
sudo apt update && sudo apt install -y git tmux
# Node.js 22 LTS (via nvm, or NodeSource packages)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22
# GitHub CLI: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
sudo apt install -y gh
```

### macOS

```sh
brew install git tmux gh node@22
```

### Windows (WSL2)

1. In PowerShell (admin): `wsl --install -d Ubuntu`, reboot, open Ubuntu.
2. Follow the Ubuntu steps **inside WSL**.
3. Keep repositories in the Linux filesystem (`~/projects/...`), **not** under `/mnt/c/...` — worktrees on the Windows drive are slow and file watching is unreliable. `aw doctor` warns about this.
4. Use Windows Terminal (or VS Code's WSL terminal) for a good tmux experience.
5. Install and log in to `codex` / `claude` / `gh` inside WSL; credentials from Windows are not shared.

### Agent CLIs

```sh
npm install -g @openai/codex            && codex login
npm install -g @anthropic-ai/claude-code && claude    # sign in on first run
gh auth login
```

## Quick start

```sh
cd ~/projects/my-saas
aw init                                   # writes .agents/workspace.yaml (detects base branch & provider)
git add .agents && git commit -m "Add Agent Workspace configuration"

aw spawn backend --provider codex --task "Build the REST API for users"
aw status
aw attach backend                         # detach again with Ctrl-b d
```

`aw spawn` on an agent that is not in `workspace.yaml` adds it for you (and creates `.agents/tasks/<agent>.md`). With `--task "..."` the task file is ready to use; without it you get a template to fill in, and the agent starts without a prompt until you do.

Example output:

```
$ aw spawn backend --provider codex --task "Build the REST API for users"
Agent Workspace

Project:   my-saas
Agent:     backend
Provider:  Codex
Branch:    agent/backend

✓ Repository validated
✓ Configuration loaded (added "backend" to .agents/workspace.yaml)
✓ Worktree created (new branch agent/backend from main)
  ~/projects/.agent-workspace/my-saas/backend
✓ Task loaded (.agents/tasks/backend.md)
✓ tmux session created (aw-my-saas-6481cd-backend)

Agent started successfully.

Attach:
  aw attach backend

Status:
  aw status
```

## The dashboard (`aw`)

Run `aw` with no arguments in a terminal (or `aw ui`) to open the interactive dashboard. In scripts and pipes, `aw` prints help as before, and every command below keeps working.

```
Agent Workspace · my-saas · 2/3 running                                        ↻ 12:14:07
┌──────────────┐┌──────────────────────────────────────────────────────────────────────┐
│ 1 Overview   ││ my-saas                                                              │
│ 2 Projects   ││ ~/projects/my-saas · base main · remote origin                       │
│ 3 Features   ││ 3 agent(s): 2 running · 1 exited · 0 stopped · 0 not started         │
│ 4 Agents     ││ Needs attention                                                      │
│ 5 Accounts   ││ • auth: agent exited (1), press r to restart                         │
│ 6 Activity   ││ Agents                                                               │
│ 7 Settings   ││ AGENT     PROVIDER STATE        BRANCH          VS BASE  CHANGES  PR │
│              ││ database  claude   ● running    agent/database  ↑1 ↓0    clean    -  │
└──────────────┘└──────────────────────────────────────────────────────────────────────┘
t attach · s start · x stop · r restart · R resume · l logs · d diff · enter details · ? help
```

- **Projects** (`2`, or `p` anywhere): register Git repositories by path (`+`); they are used in place, never copied. Switch between them, forget them (`-`, which leaves the repository untouched), initialize `.agents/` (`I`), or open a shell in one (`o`). Initialized repositories also register themselves whenever you run an `aw` command inside them. The registry lives in the machine-local data directory: `$AW_DATA_DIR`, `$XDG_DATA_HOME/agent-workspace`, `~/.local/share/agent-workspace`, or on macOS `~/Library/Application Support/agent-workspace`.
- **Agents** (`a`): each agent shows its provider, profile, model, effort, task, state, worktree, branch, ahead/behind, changes, last activity, exit status and PR. Keys:
  - `t` attaches to the agent's tmux session; detach with `Ctrl-b d` to come back to the dashboard.
  - `s` starts it, `x` stops it (asks first), `r` restarts it in the same session, `R` restarts and resumes the conversation.
  - `l` shows its terminal output, `d` shows its diff (commits, changed files, uncommitted changes).
- **Overview** (`1`): what needs attention (exited agents, conflicts, branches behind base), the agents table, and branches with their PRs. `g` refreshes PR status from GitHub through `gh`.
- **Features, Accounts, Activity, Settings**:
  - Features shows natural-language planning (Milestone 3).
  - Accounts shows detected CLIs and the "default" profile; named profiles arrive in Milestone 2.
  - Activity lists what you did in this session.
  - Settings shows the data directory and tmux settings.
- **Keys:** `tab` switches between the sidebar and the main panel, `1`–`7` jump to a view, `↑↓`/`j k` move, `enter` inspects, `?` shows help, `q` quits. Below 90 columns the sidebar becomes a one-line tab bar.
- **Safety:** quitting the dashboard never stops agents, since they live in tmux. Stopping or restarting a running agent and forgetting a project always ask for confirmation. Live data refreshes every 3 seconds.

The tmux grid from earlier versions is still available as `aw dashboard`.

## Command reference

Global options: `-C, --directory <dir>` (run as if started in `<dir>`), `--verbose` (print every executed command; same as `AW_DEBUG=1`), `-V, --version`, `-h, --help`. Every command has `--help`.

| Command | What it does |
|---------|--------------|
| `aw` / `aw ui` | Opens the interactive dashboard (see above). Without a terminal, `aw` prints help. |
| `aw projects [list\|add [path]\|remove <project>] [--json]` | Global registry of known repositories on this machine. `add` registers a repository in place; `remove` forgets it without touching it. |
| `aw doctor [--json]` | Checks platform, Node, git, tmux, gh (and auth), Codex/Claude (installed, version, expected flags), and the current repository/config. Exit 3 if something required is missing. |
| `aw init [--name] [--base] [--provider] [--remote]` | Creates `.agents/workspace.yaml`, `.agents/README.md`, `.agents/tasks/`. Never overwrites. |
| `aw add <agent> [-p] [-b] [-m] [-t text] [-d] [--scope globs] [--depends-on agents]` | Adds an agent to the config and creates its task file, without starting it. |
| `aw spawn <agent> [options] [-- provider args]` | Creates/reuses the worktree + branch and starts the agent in tmux. Idempotent: if it is already running, prints how to attach. |
| `aw attach <agent>` | Attaches your terminal to the agent's session (switches client when already inside tmux). |
| `aw restart <agent> [-r] [--prompt] [--no-prompt] [-y]` | Relaunches the agent **in its existing tmux session** (dashboard panes and attached terminals stay connected). Use it after a failed login, an accidental Ctrl-C or a crash; asks before interrupting a running agent. `-r` continues the previous conversation. |
| `aw tell <agent> <message...>` | Types a message into a running agent and presses Enter. Refused if the agent has exited (its pane is then a shell). |
| `aw sync <agent> [--ask-agent] [--no-fetch] [-y]` | `git merge` of the base branch into the agent's branch, inside its worktree (never rebase). Refuses with uncommitted changes; on conflicts the merge is left paused and listed, and `--ask-agent` hands it to the agent to resolve, test and commit. Exit 4 on unresolved conflicts. |
| `aw files [list\|add\|path]` | Shared files area outside the repo: `aw files add <file...> [--agent x] [--tell]` puts inputs in the inbox, `aw files` lists inbox and outboxes, `aw files path [--agent x] [--outbox]` prints a path. See [Files](#files-inputs-and-outputs). |
| `aw edit <agent>` | Opens the agent's task file in `$VISUAL`/`$EDITOR` (creates it from the template if missing). |
| `aw stop <agent> [-y]` | Interrupts the agent (Ctrl-C) and closes its session. Worktree, branch and commits are kept. Asks first if the agent is still running. |
| `aw status [--json] [-w [secs]]` | Agents, providers, session state, branches, ahead/behind, uncommitted changes, task, worktree path, dependencies, cached PR. |
| `aw dashboard [--per-window n] [--no-status] [--no-shell] [--no-attach] [--kill]` | tmux grid of all running agents, plus a live `status` window and a `shell` window in the main repository. |
| `aw check [--fetch] [--json] [--strict]` | Read-only safety report: shared branches, overlapping scopes, files changed outside scope, branches behind base, simulated merge conflicts with base and between agents, unmet dependencies. `--strict` exits 4 on errors (useful in scripts/CI). |
| `aw pr <agent> [--draft\|--no-draft] [--title] [--body-file] [-y] [--allow-sensitive]` | Verifies auth/remote/commits, scans for secrets, asks before pushing, avoids duplicate PRs, creates the PR, prints the URL. |
| `aw pr status [--json]` | PR number, state, checks summary and review decision for every agent branch. |
| `aw cleanup <agent> [-y] [--delete-branch] [--discard-ignored]` | Stops the session and removes the worktree if nothing can be lost: no uncommitted/untracked files, no git-ignored files other than build/dependency artifacts (e.g. a local `.env`; override with `--discard-ignored`), no commits on a detached HEAD. `--delete-branch` uses `git branch -d` (refuses unmerged branches). |
| `aw repair [-y] [--dry-run]` | Recovers from interrupted operations: stale locks, lost runtime state (re-adopts aw-marked worktrees), deleted agent worktree directories (removes their Git metadata, with confirmation), orphan tmux sessions (reported). Worktrees you created yourself are never pruned, only reported. |

`aw spawn` options:

| Option | Meaning |
|--------|---------|
| `-p, --provider <id>` | `codex` or `claude` (overrides config for this launch) |
| `-m, --model <model>` | provider-specific model name/alias |
| `-b, --branch <branch>` | branch for a new agent (default `<branchPrefix><agent>`) |
| `--base <ref>` | base for a new branch (default `project.baseBranch`) |
| `-t, --task <text>` | objective for a new agent, written to its task file |
| `--task-file <path>` | use another task file (relative to `.agents/`) |
| `--prompt <text>` | extra instructions appended to the initial prompt |
| `--no-prompt` | start the agent CLI without an initial prompt |
| `-r, --resume` | continue the provider's previous conversation in this worktree |
| `-a, --attach` | attach right after starting |
| `-y, --yes` | consent to adopting an existing worktree that aw did not create (see below) |
| `-f, --file <path>` | input file/folder for the agent: copied to its inbox and listed in the prompt (repeatable) |
| `-- <args...>` | passed verbatim to the provider CLI, e.g. `aw spawn api -- --sandbox workspace-write` |

**Exit codes:** `0` success · `1` error · `2` usage or invalid configuration · `3` missing prerequisite (tool not installed, gh not authenticated, no remote) · `4` safety refusal (dirty worktree, busy agent, branch conflict, possible secrets, `check --strict` errors) · `130` declined confirmation / interrupted.

**Non-interactive use:** any command that would ask for confirmation fails with exit 2 and a hint to pass `--yes` when no TTY is available. `status`, `check`, `doctor` and `pr status` support `--json`. Warnings go to stderr, so `--json` output on stdout stays parseable.

## Configuration reference

`.agents/workspace.yaml` is meant to be committed. It must not contain machine-specific values or secrets.

```yaml
version: 1                       # required, only 1 is supported

project:
  name: my-saas                  # required; letters, digits, ".", "_", "-"
  baseBranch: main               # default "main"
  remote: origin                 # default "origin"; used for push and PRs

workspace:
  directory: auto                # "auto" | relative path (from repo root) | absolute | ~/...
  terminal: tmux                 # only tmux in this version
  branchPrefix: agent/           # default branch = <branchPrefix><agent>
  copyFiles: [".env"]            # git-ignored local files copied into new worktrees (globs allowed)

defaults:
  provider: codex                # default provider for new agents
  createDraftPR: true            # aw pr creates drafts unless --no-draft
  autoCommit: false              # not implemented; agents commit their own work (true => warning)
  autoMerge: false               # must be false: aw never merges PRs

providers:                       # optional, per provider
  codex:
    command: codex               # executable name or path
    model: gpt-5-codex           # default model
    args: ["--sandbox", "workspace-write"]   # added to every launch
  claude:
    model: sonnet

agents:
  backend:
    provider: codex              # default: defaults.provider
    branch: feat/backend         # default: <branchPrefix><name>
    task: tasks/backend.md       # default: tasks/<name>.md (relative to .agents/)
    description: REST API        # shown when there is no task title
    model: gpt-5-codex           # overrides providers.<id>.model
    args: ["--search"]           # extra CLI args for this agent
    base: main                   # base branch override
    scope: ["src/api/**"]        # globs this agent owns (overlap warnings)
    dependsOn: [database]        # other agents this one builds on
```

Rules enforced by validation (with field-level error messages):

- agent names: 1–32 chars, lowercase letters, digits, `-`, `_`; `status`, `all`, `dashboard`, `help` are reserved;
- providers must be known (`codex`, `claude`);
- `dependsOn` must reference configured agents, no self-dependencies, no cycles;
- unknown keys are rejected (catches typos such as `provder`);
- agents sharing a branch produce a warning (Git can only check a branch out once).

**Worktree location.** `auto` puts worktrees next to the repository: `<repo-parent>/.agent-workspace/<project>/<agent>`. Because people keep repositories in different places, you can override it per machine without touching the versioned file:

```sh
export AW_WORKSPACE_DIR=~/worktrees      # => ~/worktrees/<project>/<agent>
```

If you point `workspace.directory` inside the repository, add it to `.gitignore`; `aw spawn` warns otherwise.

**Runtime state** (machine-specific: absolute paths, tmux session names, launch scripts, prompts, PR cache, locks) lives in `<git-common-dir>/agent-workspace/`, i.e. `.git/agent-workspace/` for normal clones. It is shared by all worktrees of the clone, never committed, and disposable: `aw repair` rebuilds what matters from Git itself.

**Environment variables:** `AW_WORKSPACE_DIR` (worktree root override), `AW_TMUX_SOCKET` (use a separate tmux server, `tmux -L <name>`), `AW_DEBUG=1` (debug logs), `NO_COLOR` / `FORCE_COLOR`, `AW_ASCII=1` (ASCII symbols instead of ✓ ✗ ●).

## Task files and agent context

Each agent has a Markdown brief in `.agents/tasks/`. It is plain Markdown for humans; `aw` only reads a few things from it:

- the `# Task: <title>` heading → PR title and status display,
- `## Objective` and `## Acceptance Criteria` → PR description,
- bullet items under `## Files` (or `Allowed Files` / `Preferred Files`) → scope globs for `aw check`.

Recommended sections: Objective, Technical Context, Scope, Files, Dependencies, Acceptance Criteria, Validation, Deliverables. See [`templates/task.md`](templates/task.md) and the [SaaS example](examples/saas/.agents/tasks/).

On spawn, the agent receives an initial prompt made of:

1. a short multi-agent preamble: its worktree and branch, "stay in scope", "commit to your branch; don't push, merge or rewrite history", "no secrets", the other agents and their scopes, and the state of its dependencies;
2. the full task file, unchanged;
3. any `--prompt` text.

Repository conventions are **not** duplicated: Codex reads `AGENTS.md` and Claude Code reads `CLAUDE.md` from the worktree automatically, so keep project-wide rules there. Freshly generated templates contain an `<!-- aw:template ... -->` line; while it is present, no task is sent (so an agent never starts working from placeholders). Task files over ~96 KB are referenced by path instead of inlined (OS argument-size limits).

## Files: inputs and outputs

Code moves through Git: agents commit on their branch, you review with `aw pr`. Everything else goes through two mechanisms:

**Shared files area**: `<workspace dir>/.shared/` (e.g. `~/projects/.agent-workspace/my-saas/.shared/`), outside the repository, so nothing there can be committed by accident.

```
.shared/inbox/              inputs for all agents (specs, designs, CSVs, screenshots, PDFs)
.shared/inbox/<agent>/      inputs for one agent
.shared/outbox/<agent>/     non-code deliverables from one agent (reports, analyses, exports)
```

- Agents get this directory via `--add-dir` (both Codex and Claude Code), so their sandboxes allow reading and writing it. Their prompt explains the layout.
- Inputs: `aw spawn <agent> --file spec.pdf --file designs/`, or later `aw files add mockup.png --agent web --tell` (copies it, then tells the running agent).
- Outputs: `aw files` lists every outbox. On WSL, `explorer.exe "$(aw files path)"` opens the area in Windows Explorer.
- Files are copied, never moved or overwritten: identical files are reused, different files with the same name get `name (2).ext`. `aw cleanup` never touches the shared area.

**Local files** (`workspace.copyFiles`): uncommitted, git-ignored files a fresh worktree lacks (`.env`, `*.local.json`). They are copied from the main worktree on spawn, never overwriting. Files that are *not* git-ignored are refused with a warning, because an agent could commit them. `aw cleanup` deletes unchanged copies; if the agent edited one, cleanup refuses unless `--discard-ignored`.

## Git worktrees in Agent Workspace

A [Git worktree](https://git-scm.com/docs/git-worktree) is an additional checkout of the same repository, with its own branch, index and files, sharing one object database. That gives each agent a fully isolated directory without cloning the repository again.

What `aw` does on `spawn`:

1. detects the repository, its common Git dir and main worktree (works from subdirectories, linked worktrees and bare-repo + worktree layouts);
2. if a worktree for the agent already exists, reuses it;
3. otherwise picks the branch source, in order: existing local branch → `<remote>/<branch>` (tracking; this is how you continue on another machine) → a new branch from the base (created with `--no-track`, so a stray `git push` cannot target `main`);
4. writes an ownership marker into the worktree's *Git* directory (`.git/worktrees/<id>/agent-workspace.json`) — invisible to `git status`, removed together with the worktree.

Safety rules:

- worktrees without the marker are yours: `aw` never removes or prunes them. If one already sits at an agent's path on the agent's branch (e.g. a spawn interrupted before the marker was written), `aw spawn` asks before adopting it (`--yes` in scripts);
- a branch already checked out elsewhere, a non-empty non-worktree directory at the target path, or a worktree on the wrong branch → refusal with an explanation;
- `cleanup` refuses dirty worktrees (including untracked files), worktrees containing git-ignored files that are not build/dependency artifacts (`node_modules/`, `dist/`, `.venv/`, caches… are fine; a local `.env` or database is not, unless `--discard-ignored`), worktrees whose HEAD has commits not contained in any branch (detached HEAD work would vanish with the worktree's reflog), locked worktrees and unmarked ones; it uses `git worktree remove` **without** `--force`, and `git branch -d` (never `-D`);
- `aw` never runs `reset`, `clean`, `checkout -f`, `rebase`, force-push or any history rewrite;
- per-agent lock files prevent two `aw` processes from managing the same agent at the same time. Locks are created atomically (written to a temp file, then hard-linked into place), reclaimed only when their owner process is dead (verified after an atomic rename), and released only by their owner; this is covered by a multi-process stress test.

## Codex and Claude Code integration

Providers live in `src/providers/` behind one interface (`AgentProvider`: `isInstalled`, `getVersion`, `probe`, `buildLaunchCommand`). They only *describe* a command; the tmux backend runs it. Flags were verified against the installed CLIs' `--help`:

| | Codex CLI (`codex`) | Claude Code (`claude`) |
|---|---|---|
| Verified with | codex-cli 0.165.0 | Claude Code 2.1.312 |
| Start | `codex [--model M] --cd <worktree> [args] "<prompt>"` | `claude [--model M] [args] "<prompt>"` (cwd = worktree) |
| Resume (`--resume`) | `codex resume --last --cd <worktree>` (Codex filters sessions by cwd) | `claude --continue` (most recent conversation in the worktree) |
| Model | `-m/--model` | `--model` (alias such as `sonnet`/`opus` or full name) |
| Auth | `codex login` (ChatGPT or API key, managed by Codex) | sign-in on first run (managed by Claude Code) |
| Install | `npm i -g @openai/codex` | `npm i -g @anthropic-ai/claude-code` |

`aw doctor` runs each CLI's `--help` and warns if a flag or subcommand this integration relies on (`--model`, `--cd`, `resume` for Codex; `--model`, `--continue` for Claude Code) is missing, which usually means the CLI is too old.

Notes:

- The prompt is written to a file in the runtime directory and passed as **one argument** by the launcher (`"$(cat prompt.md)"`); task text is never interpolated into shell code.
- Approval/sandbox behaviour is left to each CLI. Pass flags explicitly if you want them, e.g. `providers.codex.args: ["--sandbox", "workspace-write"]` or `aw spawn api -p claude -- --permission-mode acceptEdits`.
- Every session gets `AW_AGENT`, `AW_PROJECT`, `AW_BRANCH` and `AW_WORKTREE` in its environment (no secrets).
- **Adding a provider:** create `src/providers/<id>/<id>.ts` extending `CliProvider` (implement `buildLaunchCommand`, set `requiredFlags`, `installHint`), then register it in `src/providers/registry.ts`. Nothing else in the core changes.

## tmux sessions and the dashboard

- One detached session per agent: `aw-<project>-<clone-id>-<agent>`. The clone id (hash of the Git common dir) keeps two clones of the same project from colliding, and the `aw-` prefix keeps clear of your own sessions. Targets always use tmux's exact-match form (`=name`), so `aw` never acts on a similarly named session.
- Sessions survive terminal disconnects and closing your terminal (and SSH drops). Reattach with `aw attach <agent>`.
- When the agent CLI exits, the session stays open with a shell in the worktree and the exit code is shown in `aw status` (`◐ exited (1)`). `aw restart <agent>` (or `aw spawn <agent>`) relaunches it in the same session, so dashboard panes keep working. Press **Esc**, not Ctrl-C, to interrupt an agent without quitting it.
- `aw dashboard` creates a separate session `aw-<project>-<clone-id>--dashboard`: up to 4 agents per window in a tiled layout (`--per-window`), pane titles showing agent/provider/branch, plus a `status` window running `aw status --watch` and a `shell` window (a normal shell in the main repository for `git`, `aw tell`, `aw sync`, tests…). Each pane is a nested tmux client attached to the agent session, so typing in a pane talks to that agent.
  - The dashboard uses **Ctrl-a** as its prefix (Ctrl-b if your own prefix is already Ctrl-a), so your normal prefix still reaches the focused agent. Mouse mode is on: click to focus a pane. `Ctrl-a n/p/0-9` switches windows, `Ctrl-a w` lists them, `Ctrl-a z` zooms a pane, `Ctrl-a d` detaches. The status bar shows these keys.
  - Closing or killing the dashboard (`aw dashboard --kill`) only ends the viewer clients. **Agents keep running.**
  - Small terminals: use `--per-window 2` (or 1) for larger panes; the tiled layout adapts on resize.
- Set `AW_TMUX_SOCKET=aw` to run all agent sessions on a dedicated tmux server, fully isolated from your personal tmux.

## GitHub integration

`aw pr <agent>` is a deliberate integration checkpoint. It:

1. verifies `gh` is installed and authenticated (`gh auth status`) — authentication is entirely `gh`'s;
2. verifies the configured remote exists and is a GitHub repository `gh` can access (github.com or GitHub Enterprise);
3. resolves the agent's branch and warns about uncommitted changes in its worktree (they are not committed for you);
4. requires at least one commit ahead of the base branch;
5. refuses to publish if **any commit the push would send** (everything not already on the remote, not just the net diff — a secret added and later deleted is still in history) touches sensitive files (`.env`, private keys, `.npmrc`, credentials files, `.agent-workspace/`) or adds lines that look like secrets (private keys, AWS/GitHub/OpenAI/Anthropic/Slack/Google tokens) — override only with `--allow-sensitive`;
6. reuses an existing open PR for the branch instead of creating a duplicate;
7. asks before pushing (`git push --set-upstream <remote> <branch>`, never `--force`) and refuses if the remote branch has diverged;
8. creates the PR against the base branch (draft by default, from `defaults.createDraftPR`), with a title from the task and a body from the objective, acceptance criteria and commit list;
9. prints the URL and caches the PR in runtime state for `aw status`.

`aw pr status` shows every agent's PR, state (draft/open/merged/closed), CI checks summary and review decision. `aw` never merges.

## Parallel development safety

Worktrees remove *file-level* collisions; they do not remove *logical* conflicts. Two agents can both compile and pass tests and still be incompatible. Agent Workspace surfaces risks early and leaves decisions to you:

- **Shared branch** → error in `aw check` and a config warning; Git refuses at spawn.
- **Same agent managed twice** → per-agent locks (`exit 4`, "busy").
- **Overlapping scopes** (config `scope` + task `## Files`) → warning in `aw check`.
- **Files changed outside the declared scope** → warning.
- **Files changed by several agents** → warning, or error if a simulated merge conflicts.
- **Branch behind base** → warning at spawn and in `aw check`; ahead/behind in `aw status`.
- **Conflicts with the base branch or between agents** → `git merge-tree --write-tree` simulation (Git 2.38+); nothing in any worktree or ref changes.
- **Dependencies** (`dependsOn`) → shown in status, in the agent's prompt, and in `aw check` until the dependency's PR is merged.

`dependsOn` documents *integration order and shared contracts*, not "cannot start". It is the foundation for future dependency-aware scheduling; this version does not schedule or merge anything automatically.

## Working across machines

Everything needed to recreate the environment is in Git:

```sh
# machine A
aw pr backend            # or just: git push -u origin feat/backend
git push                 # .agents/ config and task files

# machine B
git clone git@github.com:you/my-saas.git && cd my-saas
aw doctor
aw spawn backend            # worktree created from origin/feat/backend (tracking), fresh conversation + task prompt
```

Agent conversations are stored by each CLI on the machine where they ran, so `--resume` only helps on the same machine; on a new machine the agent starts a fresh conversation from the task file and the commits already on the branch. Runtime state is never synced — `aw` does not assume a worktree created on one machine exists on another.

## Example: building a SaaS with five agents

A complete, validated example lives in [`examples/saas/.agents/`](examples/saas/.agents/) (config + five task files). Walkthrough: [`docs/example-saas.md`](docs/example-saas.md). A recorded terminal session of three agents in one repository (status, conflict detection, dashboard, stop, refused and successful cleanup) is in [`docs/demo.md`](docs/demo.md).

```
                ┌──────────► backend ─────────┐
  contracts ──► database                      ├──► admin (data views)
  (human, on    └──────────► auth ──► rbac ───┘
   main first)
```

| Agent | Provider | Can start | Merges after | Why |
|-------|----------|-----------|--------------|-----|
| database | claude | immediately | — | owns the schema everyone else uses |
| backend | codex | immediately, against repository interfaces | database | needs real repositories to integrate |
| auth | claude | immediately, against the `users` contract | database | needs the users table |
| rbac | codex | once auth's identity contract exists (stub OK) | auth | builds on `request.identity` |
| admin | claude | UI shell immediately against a mock API | backend, rbac | data views need real endpoints + role rules |

The key move is **step 0**: a human commits the shared contracts (`docs/contracts/`: entities, repository interfaces, identity type, OpenAPI skeleton, permission matrix) to `main` before spawning. Contracts turn sequential dependencies into parallel work. `aw check` then tells you when reality drifts from that plan.

## Architecture

```
src/
├── index.ts                      # entry point (bin: aw)
├── cli/                          # commander program, run loop, rendering (thin adapters)
├── tui/                          # Ink dashboard: pure state/keys (state.ts), views, App, launcher
├── core/
│   ├── agents/service.ts         # lifecycle: add, spawn, stop, attach, status, cleanup
│   ├── config/                   # zod schema, YAML loading, comment-preserving edits
│   ├── git/git.ts                # typed git CLI wrapper (safe operations only)
│   ├── github/                   # gh client + PR workflow
│   ├── safety/                   # overlap/secret heuristics, aw check
│   ├── sessions/                 # launcher scripts, session state, dashboard
│   ├── state/runtime-state.ts    # machine-local state in .git/agent-workspace
│   ├── tasks/                    # task parsing, prompt building
│   ├── projects/                 # data directory + global project registry
│   ├── workspace/                # workspace resolution, init, doctor, repair, snapshot + controller (TUI boundary)
│   ├── worktrees/manager.ts      # worktree creation, adoption, safe removal
│   ├── deps.ts                   # dependency container (DI for tests)
│   └── errors.ts                 # AwError + exit codes
├── providers/                    # AgentProvider interface, codex, claude, registry
└── infrastructure/
    ├── process/                  # child processes (argv arrays, no shell), quoting
    ├── filesystem/               # atomic writes, locks, package paths
    └── terminal/                 # TerminalBackend interface, tmux, ui, prompts
```

Design choices, the state model and the risk analysis are in [`docs/architecture.md`](docs/architecture.md). The direction toward an integrated environment (domain model, SQLite, managed execution, profiles, routing) is in [ADR 0001](docs/adr/0001-integrated-environment.md).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Command not found: tmux` / exit 3 | Install tmux (`apt install tmux` / `brew install tmux`), run `aw doctor`. |
| `Codex CLI not found ("codex")` | Install it, or set `providers.codex.command` to its path. |
| Agent shows `◐ exited (1)` / pressed Ctrl-C by mistake | `aw attach <agent>` to read the error (often: not logged in; run `claude` → `/login` or `codex login` in a normal terminal once). Then `aw restart <agent>` (add `--resume` to continue the conversation). The dashboard pane reconnects automatically. |
| `Agent "x" is busy` | Another `aw` command is running for that agent. If none is, `aw repair`. |
| `Branch ... is already checked out at ...` | That branch is used by another worktree. Use `--branch`, or switch/remove the other worktree. |
| `refusing to clean up` | The worktree has uncommitted/untracked files. Commit, stash or delete them yourself. |
| `The repository has no commits yet` (fresh `git init`) | Worktrees branch off a commit: `git add .agents && git commit -m "Add Agent Workspace configuration"`, then spawn again. |
| `This repository has not been initialized` | `aw init` in the repository root (or `git pull` the `.agents/` directory). |
| Worktree directory deleted manually | `aw repair` (removes that agent worktree's Git metadata after confirmation, forgets the agent; the branch stays). |
| `ignored files that would be deleted` on cleanup | Move what you need (e.g. `.env`) out of the worktree, or `aw cleanup <agent> --discard-ignored`. |
| `not created by Agent Workspace` on spawn | A worktree you made sits at the agent's path. `aw spawn <agent> --yes` adopts it, or move it away. |
| Runtime state lost/corrupted | `aw repair` re-adopts marked worktrees. A corrupt `state.json` is backed up automatically. |
| `aw attach` inside the dashboard | Not needed: click the pane (mouse) or use `Ctrl-a` + arrow keys. |
| Keys go to the dashboard instead of the agent | The dashboard prefix is Ctrl-a; your usual prefix (Ctrl-b) goes to the focused agent. |
| Slow on WSL2 | Move the repo from `/mnt/c/...` into `~/...`. |
| `gh` errors in `aw pr` | `gh auth status`; for GitHub Enterprise `gh auth login --hostname <host>`. |
| See exactly what ran | `aw --verbose <command>` prints every git/tmux/gh invocation. |

## Known limitations

- tmux is the only terminal backend; native Windows is not supported (use WSL2).
- `aw stop` interrupts with Ctrl-C and then closes the session; an agent mid-edit may leave partial (uncommitted, preserved) changes.
- Secret scanning is a best-effort heuristic, not a replacement for a dedicated scanner or GitHub push protection.
- Scope overlap uses conservative glob-prefix comparison; it can report possible overlaps that never materialize.
- Dependency state is derived from PR state cached by `aw pr` / `aw pr status`; there is no scheduler.
- PRs from forks (`owner:branch` heads) are not supported; the branch is pushed to the configured remote.
- `autoCommit` is accepted but not implemented (agents commit their own work).
- The dashboard nests tmux clients; very small terminals give cramped panes (use `--per-window`).
- Codex/Claude flags evolve; integration verified with codex-cli 0.165.0 and Claude Code 2.1.312. `aw doctor` flags missing options.

## Security considerations

- **No credentials handled.** Providers and `gh` use their own login mechanisms; `aw` stores no tokens and puts nothing secret in config, prompts, environment or state.
- **No shell injection.** External tools are run with argument arrays and `shell: false`. The only shell code is the generated launcher, whose values are POSIX-quoted, with the prompt read from a file at runtime. tmux sessions are created with multi-argument commands, so tmux executes them directly rather than via a shell.
- **Private runtime files.** Prompts are written with mode 0600 and launchers with 0700 inside `.git/agent-workspace/`, never inside the working tree.
- **No destructive Git.** No force operations, resets, cleans, rebases or history rewrites. Removal requires a clean worktree and confirmation; branches are deleted only with `-d`.
- **Confirmation for outward/destructive actions** (push, stop a running agent, cleanup, prune); non-interactive runs require an explicit `--yes`.
- **Publication guard.** `aw pr` scans every commit it would push for sensitive files and likely secrets and blocks unless `--allow-sensitive`.
- **Versioned config is input from whoever committed it.** `providers.<id>.command` and `args` in a cloned repository choose what runs. `aw spawn` warns when the config sets a custom executable or passes flags that disable an agent's sandbox/approvals (e.g. `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-skip-permissions`). Review `.agents/workspace.yaml` before spawning in repositories you don't trust.
- **Agents themselves are powerful.** Each agent CLI runs with your user's permissions in its worktree; worktrees isolate files, not processes. Use the providers' sandbox/approval settings and review every PR.

## Development

```sh
npm install
npm run typecheck     # strict TypeScript, includes tests
npm run build         # emits dist/
npm test              # vitest: unit + integration (temp repos, private tmux server)
```

Tests never touch your repositories, global Git config or tmux server: they create temporary repositories, set `GIT_CONFIG_GLOBAL` to a temp file, and run tmux on a private socket. Integration tests that need tmux are skipped automatically when tmux is not installed.

License: MIT.
