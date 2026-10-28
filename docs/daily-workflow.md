# Daily workflow

A practical guide to using `aw` every day: the loop, the keys, recovering agents, writing better tasks, and handling conflicts.

## The daily loop

```sh
cd ~/Projetos/my-saas
aw                             # the dashboard: projects, agents, branches, PRs (q quits, agents keep running)
aw status                      # the same information as plain text, for scripts and quick checks
aw dashboard                   # tmux grid of every agent's terminal side by side
# ... agents work; you review, answer questions, steer ...
aw check                       # any overlaps / conflicts / stale branches?
aw sync backend                # bring main into a branch that fell behind
aw pr backend                  # publish a finished piece of work
aw cleanup backend --delete-branch   # after the PR is merged
```

Rule of thumb: **one agent = one branch = one PR-sized piece of work.** Small tasks merge easily; big ones conflict.

## Before the first spawn: log in once

Each agent CLI keeps its own login. Do it once in a normal terminal (not inside `aw`):

```sh
claude          # then /login inside Claude Code, then /exit
codex login
gh auth login
```

All agents then reuse those credentials.

## Dashboard keys

The dashboard is a tmux session. Its prefix is **Ctrl-a** (or Ctrl-b if your own tmux prefix is already Ctrl-a). The bottom-right of the status bar always shows the reminder.

| Keys | Action |
|------|--------|
| click a pane | focus it (mouse mode is on) |
| `Ctrl-a` + arrow keys | move between panes |
| `Ctrl-a z` | zoom the focused pane to full screen and back (best way to read an agent) |
| `Ctrl-a n` / `Ctrl-a p` | next / previous window |
| `Ctrl-a 0` … `Ctrl-a 9` | jump to window by number |
| `Ctrl-a w` | interactive list of windows and panes (arrows + Enter) |
| `Ctrl-a [` or mouse wheel | scroll back (q to leave) |
| `Ctrl-a d` | detach: back to the terminal you were in; agents keep running |

Windows in the dashboard:

- `agents` (or `agents-1`, `agents-2`, … when there are more than 4): one pane per running agent. Typing in a pane talks to that agent.
- `status`: `aw status --watch`, refreshed every 3 seconds.
- `shell`: a normal shell in the main repository. Run anything here: `aw tell`, `aw sync`, `git log`, `npm test`. On WSL you can call Windows programs too (`explorer.exe .`, `code .`, `powershell.exe`).

To get back to the dashboard later: `aw dashboard` (rebuilds it with the agents running now) or `tmux attach -t "=aw-<project>-<id>--dashboard"`.

Inside a single agent (`aw attach <agent>`) the prefix is your normal one (Ctrl-b): `Ctrl-b d` detaches.

## Don't press Ctrl-C to stop an agent

Ctrl-C quits Claude Code / Codex. To interrupt what the agent is doing **without quitting**, press **Esc**. If an agent did quit (Ctrl-C, failed login, crash), its pane shows `[aw] Agent process exited…` and a shell. Then:

```sh
aw restart <agent>             # new conversation with the task prompt
aw restart <agent> --resume    # continue the previous conversation
```

`restart` relaunches the agent **inside the same tmux session**, so the dashboard pane and any attached terminal stay connected; nothing needs rebuilding. `aw spawn <agent>` does the same when the agent has exited. If the agent is still running, `restart` asks before interrupting it.

## Talking to agents

Agents are interactive. The task file is only the **first message**: after that, steer them like a colleague, directly in their pane or from the shell window:

```sh
aw tell backend "Use the UserRepository interface from docs/contracts instead of importing the ORM."
aw tell auth "Commit what you have with a clear message."
```

`aw tell` refuses when the agent has exited, because its pane then holds a shell and your text would run as a command.

## Writing better tasks than `--task`

`--task "..."` is fine for small jobs. For real work, write the task file:

```sh
aw add billing --provider claude --scope "src/billing/**" --depends-on database
aw edit billing                # opens .agents/tasks/billing.md in $EDITOR (template)
# fill it in, delete the "aw:template" line
git add .agents && git commit -m "Task: billing"
aw spawn billing
```

What makes a task file good:

- **Objective**: one or two sentences on the outcome, not the steps.
- **Technical context**: stack, where related code lives, links to contracts (`docs/contracts/...`), decisions already made.
- **Scope and Files**: what's in and what's explicitly out, plus globs (`src/billing/**`). `aw check` uses these.
- **Dependencies**: which contracts or agents it relies on, and what to do if they're missing ("use the in-memory fake").
- **Acceptance criteria**: observable, testable statements.
- **Validation**: exact commands to run (`npm test -- src/billing`).

See `examples/saas/.agents/tasks/` for complete examples.

Three layers of instructions, from broadest to narrowest:

| Layer | Where | For |
|-------|-------|-----|
| Repository rules | `AGENTS.md` (Codex) and `CLAUDE.md` (Claude Code) at the repo root, committed | conventions every agent must follow: stack, style, test commands, "never edit generated files" |
| Task | `.agents/tasks/<agent>.md` | this agent's job |
| One-off | `aw spawn <agent> --prompt "..."`, `aw restart <agent> --prompt "..."`, `aw tell` | extra steering right now |

Let an agent draft the tasks: run `claude` (or `codex`) in the main repo and ask: *"Read the codebase and docs/contracts, then write .agents/tasks/billing.md following the format of .agents/tasks/auth.md: objective, context, scope, files, dependencies, acceptance criteria, validation."* Review it, commit, spawn.

## Files: giving agents inputs, getting outputs

Code always comes back as commits on the agent's branch. Review it with `aw pr <agent>`, or look directly in the worktree: `code ~/Projetos/.agent-workspace/my-saas/<agent>`, `git -C <worktree> log -p`.

For everything else there is a shared area outside the repository (nothing in it can be committed by accident):

```sh
aw spawn billing --file ~/Downloads/stripe-spec.pdf --file ./mockups/   # inputs at start (listed in the prompt)
aw files add screenshot-bug.png --agent web --tell                      # inputs later (copies + notifies the agent)
aw files add schema-v2.sql                                              # input for every agent
aw files                                                                # list inbox and every agent's outbox
explorer.exe "$(aw files path)"                                         # WSL: open it in Windows Explorer
```

Agents put non-code deliverables (reports, analyses, CSV exports, screenshots) in `outbox/<agent>/`. Their prompt says so, and you can ask explicitly: `aw tell research "Write the comparison to your outbox as comparison.md"`.

Images: both CLIs can read image files by path. Mention the path in a message (`aw tell web "Compare the UI with $(aw files path --agent web)/mockup.png"`). Claude Code also accepts drag-and-drop or pasted images in its pane.

Local files a fresh worktree lacks (`.env`, local configs): list them once in `.agents/workspace.yaml` and every new worktree gets a copy:

```yaml
workspace:
  copyFiles: [".env", "apps/web/.env.local"]
```

Only git-ignored files are copied, so an agent can't commit them by accident. Cleanup deletes untouched copies by itself and protects copies the agent edited.

## Handling conflicts

Worktrees stop agents from overwriting each other's files. They don't stop two branches from disagreeing. The strategy has three parts: prevent, detect early, then integrate in order.

**1. Prevent (most of the value)**

- Agree on contracts first (types, interfaces, API shapes) and commit them to `main` before spawning.
- Give every agent a `scope`, and give hot files a single owner (`src/app.ts`, route registration, `package.json`). Other agents export plugins or describe the change in their PR.
- Keep tasks small and merge often. A branch that lives for a week will conflict.

**2. Detect early**

```sh
aw check            # read-only: shared files, out-of-scope edits, branches behind main, simulated merge conflicts
aw check --fetch    # same, after fetching main from GitHub
```

Run it a few times a day. Act on warnings while they're small: `aw tell` the agent that strayed out of scope.

**3. Integrate in dependency order**

Merge the PR everyone depends on first (e.g. `database`), then bring `main` into the others:

```sh
aw sync backend                 # git merge main into backend's branch, inside its worktree
```

- No conflicts: done. Tell the agent to re-run tests: `aw tell backend "main was merged into your branch; run the tests."`
- Conflicts: the merge is paused with conflict markers. Choose:

```sh
aw sync backend --ask-agent     # hands the conflict list to the agent: resolve, test, commit
# or resolve yourself:
cd ~/Projetos/.agent-workspace/my-saas/backend
code .                          # VS Code shows "Accept current / incoming / both"
git add <files> && git commit
# or undo:
git merge --abort
```

The agent is usually the best resolver: it knows why it wrote its side, and it can run the tests. `aw sync` never rebases, never force-pushes, and refuses if the worktree has uncommitted changes or a merge is already in progress.

## Quick reference

| I want to… | Command |
|------------|---------|
| see everything | `aw status` / `aw dashboard` |
| start an agent | `aw spawn <agent> [-p claude] [-t "..."]` |
| fix an agent that quit | `aw restart <agent> [--resume]` |
| send it a message | `aw tell <agent> "..."` |
| look at one agent full screen | `aw attach <agent>` (or `Ctrl-a z` in the dashboard) |
| write or edit its task | `aw edit <agent>` |
| give it a file | `aw files add <file> --agent <agent> --tell` (or `aw spawn <agent> --file <file>`) |
| see what agents produced | `aw files` (outboxes) · `aw pr <agent>` (code) |
| check for conflicts | `aw check` |
| bring main into its branch | `aw sync <agent> [--ask-agent]` |
| publish its work | `aw pr <agent>` |
| finish it | `aw cleanup <agent> --delete-branch` |
| stop it for today | `aw stop <agent>` (resume tomorrow: `aw spawn <agent> --resume`) |
