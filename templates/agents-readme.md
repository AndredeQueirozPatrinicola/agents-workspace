# .agents

This directory configures Agent Workspace (`aw`),
which runs multiple AI coding agents in parallel, each in its own Git worktree and branch.

- `workspace.yaml` — project and agent configuration (versioned).
- `tasks/*.md` — one human-editable task brief per agent.

Common commands:

```sh
aw status            # agents, branches, sessions, PRs
aw spawn <agent>     # create worktree + branch and launch the agent in tmux
aw attach <agent>    # attach to the agent's terminal
aw dashboard         # tmux grid of all running agents
aw check             # overlap / behind-base / conflict report
aw pr <agent>        # push the branch and open a (draft) PR
aw cleanup <agent>   # remove a finished agent's worktree safely
```

Repository-wide instructions for agents belong in `AGENTS.md` / `CLAUDE.md`, not here.
