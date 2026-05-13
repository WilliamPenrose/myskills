# MySkills

A marketplace of unrelated agent skills for **Claude Code**, **Codex**, and other compatible agents.

| Skill | One-liner |
|---|---|
| [`app-reviews`](plugins/app-reviews/skills/app-reviews/SKILL.md) | Mobile app review analysis — pulls Google Play / Apple App Store reviews into local SQLite, filters by rule-based heuristics, emits the highest-signal subset as JSON for direct LLM analysis. |
| [`qly`](plugins/qly/skills/qly/SKILL.md) | Douyin e-commerce competitive monitoring — drives a logged-in qlydata.com browser session to harvest products by keyword, score relevance with a local Chinese embedding model, and trace the influencers selling each kept product. |

## Install — Claude Code

```
/plugin marketplace add WilliamPenrose/myskills
/plugin install <skill>@myskills
```

Replace `<skill>` with `app-reviews` or `qly`. See the per-skill sections below for prerequisites.

## Install — other agents

```
npx skills add WilliamPenrose/myskills -a codex      # OpenAI Codex
npx skills add WilliamPenrose/myskills -a cursor     # Cursor
npx skills add WilliamPenrose/myskills -a windsurf   # Windsurf
npx skills add WilliamPenrose/myskills -a opencode   # OpenCode
npx skills add WilliamPenrose/myskills -a openclaw   # OpenClaw
npx skills add WilliamPenrose/myskills -a trae       # Trae
```

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

## app-reviews

Fetches Google Play and Apple App Store reviews into a local SQLite store, runs rule-based heuristic filters (length, language, sentiment cues, etc.), and emits the highest-signal subset as JSON for an LLM to analyze. Typical use: surfacing what users complain about in the last N days of reviews for a specific app.

Install:

```
/plugin install app-reviews@myskills
```

Prerequisites:

- `npm install` inside the skill directory (one-time, pulls scrapers and the SQLite helper)

Full docs: [`plugins/app-reviews/skills/app-reviews/SKILL.md`](plugins/app-reviews/skills/app-reviews/SKILL.md)

## qly

Drives a logged-in qlydata.com browser session to (a) pull product lists for each monitored keyword, (b) auto-score product relevance with a local Chinese embedding model and surface borderline cases for human review, (c) for each kept product, look up which influencer accounts livestream-sold it. Typical use: weekly competitive monitoring of Douyin e-commerce for a defined keyword set.

Install:

```
/plugin install qly@myskills
```

Prerequisites:

- `npm install` inside the skill directory. First `relevance score` run downloads the BGE Chinese embedding model (~400 MB) into a local cache.
- A site-use chrome instance with a qlydata.com account login. The skill walks the user through this on first run (account credentials are entered in the browser window; cookies persist in the chrome profile).
- A keyword list xlsx or csv maintained by the user, with `key_word` and `is_track` columns.

First-run usage is guided — invoking the skill with no existing config triggers an onboarding dialogue that asks for the keyword file, filter ranges, and influencer thresholds, then walks the pipeline end to end.

Full docs: [`plugins/qly/skills/qly/SKILL.md`](plugins/qly/skills/qly/SKILL.md)

## Update

```
npx skills update <skill>
```

## License

[MIT](LICENSE)
