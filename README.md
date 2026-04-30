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
npx skills add WilliamPenrose/myskills -a codex      # OpenAI Codex
npx skills add WilliamPenrose/myskills -a cursor     # Cursor
npx skills add WilliamPenrose/myskills -a windsurf   # Windsurf
npx skills add WilliamPenrose/myskills -a opencode   # OpenCode
npx skills add WilliamPenrose/myskills -a openclaw   # OpenClaw
npx skills add WilliamPenrose/myskills -a trae       # Trae
```

For other agents, substitute `-a <agent>` with one of:

<details>
<summary>Full list of supported <code>-a</code> values</summary>

```
adal            cortex          gemini-cli      kode            qwen-code
aider-desk      crush           github-copilot  mcpjam          replit
amp             deepagents      goose           mistral-vibe    roo
antigravity     devin           iflow-cli       mux             rovodev
augment         dexto           junie           neovate         tabnine-cli
bob             droid           kilo            openhands       trae-cn
cline           firebender      kimi-cli        pi              universal
codearts-agent  forgecode       kiro-cli        pochi           warp
codebuddy                                       qoder           zencoder
codemaker
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
