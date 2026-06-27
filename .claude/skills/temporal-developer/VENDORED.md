# Vendored: temporal-developer skill

Source: https://github.com/temporalio/skill-temporal-developer
Upstream version: 0.5.0
Vendored commit: 3973e73202f72cb6b157b827f270c04f96ad8c1f
License: MIT (see ./LICENSE) — © 2026 Temporal Technologies Inc.

## What was vendored
The **TypeScript + Python subset** of the official skill — Flowstile ships both a
TypeScript (`packages/worker`) and a Python (`sdk-python`) worker SDK, so we keep
the references for both:

- `SKILL.md`, `README.md`, `LICENSE` (verbatim, unmodified)
- `references/core/` — language-agnostic determinism, patterns, gotchas,
  versioning, troubleshooting, CLI, etc.
- `references/typescript/` and `references/python/` — language-specific
  determinism, patterns, gotchas, versioning, testing, etc.

We dropped `references/{go,java,dotnet,ruby,rust}/`. `SKILL.md` detects the
project language and reads only the matching subset, so the dropped paths are
never followed in this repo.

## Updating
Re-fetch upstream and re-copy the same subset (the `references/python/` files were
added via raw fetch when a clone was unavailable):

    git clone --depth 1 https://github.com/temporalio/skill-temporal-developer /tmp/sk
    cp /tmp/sk/SKILL.md /tmp/sk/README.md /tmp/sk/LICENSE .claude/skills/temporal-developer/
    rm -rf .claude/skills/temporal-developer/references/{core,typescript,python}
    cp -r /tmp/sk/references/{core,typescript,python} .claude/skills/temporal-developer/references/

Then bump the version/commit recorded above.
