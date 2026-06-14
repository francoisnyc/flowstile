# Vendored: temporal-developer skill

Source: https://github.com/temporalio/skill-temporal-developer
Upstream version: 0.5.0
Vendored commit: 3973e73202f72cb6b157b827f270c04f96ad8c1f
License: MIT (see ./LICENSE) — © 2026 Temporal Technologies Inc.

## What was vendored
This is the **TypeScript subset** of the official skill. Flowstile is a
TypeScript monorepo, so we kept only the parts the agent would actually read:

- `SKILL.md`, `README.md`, `LICENSE` (verbatim, unmodified)
- `references/core/` — language-agnostic determinism, patterns, gotchas,
  versioning, troubleshooting, CLI, etc.
- `references/typescript/` — TS-specific determinism, patterns, gotchas,
  versioning, testing, etc.

We intentionally dropped `references/{python,go,java,dotnet,ruby,rust}/`.
`SKILL.md` detects the project language and only reads `references/typescript/`
here, so the dropped paths are never followed in this repo.

## Updating
Re-clone upstream and re-copy the same subset:

    git clone --depth 1 https://github.com/temporalio/skill-temporal-developer /tmp/sk
    cp /tmp/sk/SKILL.md /tmp/sk/README.md /tmp/sk/LICENSE .claude/skills/temporal-developer/
    rm -rf .claude/skills/temporal-developer/references/{core,typescript}
    cp -r /tmp/sk/references/{core,typescript} .claude/skills/temporal-developer/references/

Then bump the version/commit recorded above.
