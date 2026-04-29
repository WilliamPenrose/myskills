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

## Install — Codex

Codex uses the community [`codex-plugin`](https://github.com/callstackincubator/agent-skills/tree/main/packages/codex-plugin) CLI:

```
npx codex-plugin add WilliamPenrose/myskills
```

## License

[MIT](LICENSE)
