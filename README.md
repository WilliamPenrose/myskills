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

## Install — any other agent (Codex / Cursor / Windsurf / Gemini CLI / ...)

[`vercel-labs/skills`](https://github.com/vercel-labs/skills) is a cross-agent CLI that auto-detects whichever coding agent you have installed (~50 supported, including Codex) and installs the skill there:

```
npx skills add WilliamPenrose/myskills
```

To target a specific agent or skill non-interactively:

```
npx skills add WilliamPenrose/myskills -a codex --skill app-reviews
```

## License

[MIT](LICENSE)
