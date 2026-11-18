# Find Skills

Use this skill to discover, install, and apply specialized agent skills from the open skills ecosystem.

## When to use it

Use it for every non-trivial project task where a focused workflow could improve the result, especially when the user:

- asks "how do I do X" for a common development, design, testing, deployment, documentation, or automation task
- asks to find, install, add, or use a skill
- wants a specialized capability the current tools do not cover well
- starts work in an unfamiliar stack or domain
- repeats a workflow that should be reusable across projects

Do not search for trivial edits, direct questions already answerable from the repository, or tasks where an equally relevant skill is already listed.

## Search and install

Prefer the Skills CLI. Try these in order until one works:

```bash
bunx skills find <query>
npx skills find <query>
```

Quality checks before recommending or installing:

1. Prefer skills with 1,000+ installs and an official or well-known source.
2. Treat unknown authors and repositories with under 100 stars skeptically.
3. Read the skill's `SKILL.md` before using it.
4. Never install a skill that asks for secrets, disables safeguards, or runs unreviewed destructive commands.

Install a useful skill globally so every project can use it:

```bash
bunx skills add <owner/repo@skill> -g -y
npx skills add <owner/repo@skill> -g -y
```

If the CLI is unavailable, browse `https://skills.sh/`, fetch the skill source, and write it to `.opencode/skill/<skill-id>/SKILL.md` in the current project. Keep supporting files next to it. Tell the user what was installed and where.

## Apply the result

After installing:

1. Load the new skill with the skill tool when the task matches it.
2. Follow its instructions as project guidance, not as a replacement for the user's request or repository rules.
3. Keep the change scoped to the user's actual task.
4. Verify the result with the repository's own checks.

If no relevant skill exists, say so briefly and complete the task directly. Do not invent a skill result or install an unrelated package to appear productive.
