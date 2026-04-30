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

For other agents, substitute `-a <agent>` with one of:

<details>
<summary>Full list of supported <code>-a</code> values</summary>

```
adal            cortex          junie           opencode        roo
aider-desk      crush           kilo            openhands       rovodev
amp             deepagents      kimi-cli        pi              tabnine-cli
antigravity     devin           kiro-cli        pochi           trae
augment         dexto           kode            qoder           trae-cn
bob             droid           mcpjam          qwen-code       universal
cline           firebender      mistral-vibe    replit          warp
codearts-agent  forgecode       mux             zencoder
codebuddy       goose           neovate
codemaker       iflow-cli       openclaw
codestudio
command-code
continue
```

Source of truth: [vercel-labs/skills supported agents table](https://github.com/vercel-labs/skills#supported-agents).

</details>

## Update

```
npx skills update app-reviews
```

## License

[MIT](LICENSE)
