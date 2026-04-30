# MySkills

A marketplace of agent skills for **Claude Code** and **Codex**.

## Available skills

| Skill | What it does |
|---|---|
| [`app-reviews`](plugins/app-reviews/skills/app-reviews/SKILL.md) | Fetch Google Play / Apple App Store reviews into local SQLite, filter by rule-based heuristics, emit the highest-signal subset as JSON for direct LLM analysis. |

## Install — Claude Code

```
/plugin marketplace add WilliamPenrose/myskills
/plugin install app-reviews@myskills
```

After install, some skills require a one-time `npm install` inside the skill directory (see the skill's own `SKILL.md` — `app-reviews` does).

## Install — other agents

```
npx skills add WilliamPenrose/myskills -a codex            # OpenAI Codex
npx skills add WilliamPenrose/myskills -a cursor           # Cursor
npx skills add WilliamPenrose/myskills -a windsurf         # Windsurf
npx skills add WilliamPenrose/myskills -a gemini-cli       # Gemini CLI
npx skills add WilliamPenrose/myskills -a github-copilot   # GitHub Copilot
```

For [other agents](https://github.com/vercel-labs/skills#supported-agents), substitute `-a <agent>`.

## Update

```
npx skills update app-reviews
```

## License

[MIT](LICENSE)
