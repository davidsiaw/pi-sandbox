---
name: pa-example
description: Placeholder skill baked into the pa sandbox image. Demonstrates how
  image-shipped skills are structured and loaded. Safe to delete once you add
  real skills.
---

<!--
  ═══════════════════════════════════════════════════════════════════════════
  READ THIS FIRST (for the next agent adding a real skill)
  ═══════════════════════════════════════════════════════════════════════════

  WHERE THIS LIVES
    Repo:      picon/pa-skills/<name>/SKILL.md
    In image:  /opt/pa/skills/<name>/SKILL.md   (COPY in the Dockerfile)
    Loaded by: the `pa` launcher, which passes `--skill /opt/pa/skills`. pi
               discovers every subdirectory under it that contains a SKILL.md,
               recursively.

    Do NOT bake skills into ~/.pi/agent/skills — `pa` mounts that path
    read-write from the host, so a baked copy there would be shadowed at
    runtime. Baked skills must live under /opt/pa and load via --skill.

  FRONTMATTER (YAML at the very top, between the --- fences)
    name         REQUIRED. 1-64 chars, lowercase a-z / 0-9 / hyphens only. No
                 leading/trailing or consecutive hyphens. Pi does NOT require
                 the name to match the directory. Give baked skills a unique
                 name (we prefix `pa-`) so they never collide with a host skill;
                 on a collision pi keeps the first found and warns.
    description  REQUIRED. Max 1024 chars. This is the ONLY part always in the
                 model's context — it decides WHEN the skill is loaded. Be
                 specific about what it does and when to use it. A skill with no
                 description is not loaded at all.
    Optional:    license, compatibility, metadata, allowed-tools,
                 disable-model-invocation (true = hidden from prompt, user must
                 run /skill:<name> explicitly).

  HOW SKILLS WORK (progressive disclosure)
    At startup pi puts only the name+description into the system prompt. The
    full body below is loaded on demand when the model decides the task matches
    (or when the user runs /skill:<name>). Models don't always auto-load — if a
    skill must always apply, prompt for it or use /skill:<name>. For always-on
    environment facts, prefer APPEND_SYSTEM (see pa-context/) over a skill.

  STRUCTURE
    A skill is a directory with a SKILL.md. Everything else is freeform:
      <name>/
      ├── SKILL.md              this file (frontmatter + instructions)
      ├── scripts/              helper scripts you reference below
      ├── references/           extra docs loaded on demand
      └── assets/               templates, fixtures, etc.
    Reference bundled files with RELATIVE paths, e.g.
      See [the reference](references/REFERENCE.md) for details.
      Run `./scripts/do-thing.sh <input>`.

  BODY BELOW
    Write the actual instructions the agent should follow when the skill loads:
    setup steps, commands, gotchas. Keep it actionable. Delete the placeholder
    text and write your real skill, or delete this whole subdirectory if you
    don't need a baked skill.
-->

# pa-example

This is an example skill baked into the `pa` sandbox image at
`/opt/pa/skills/pa-example`. It exists to prove the baked-skill wiring works and
to show the expected layout. It does nothing useful — replace it.

## When to use

Never, in practice — it's a template. A real skill's `description` frontmatter
above would tell the model exactly when to load it.

## Example instruction

If this were a real skill, this section would contain the concrete steps the
agent should take, e.g.:

```bash
./scripts/setup.sh          # one-time setup
./scripts/run.sh <input>    # do the thing
```
