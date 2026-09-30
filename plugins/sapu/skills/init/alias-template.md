---
name: <name>
description: Shortcut for /sapu:<name> from the sapu plugin, so the owner can type /<name>. Used only when the user types /<name>.
disable-model-invocation: true
---

Invoke the Skill tool with `skill: "sapu:<name>"` and the user's arguments unchanged: $ARGUMENTS

If the Skill tool has no `sapu:<name>`, the sapu plugin is not enabled in this repo. Tell the user to run `claude plugin install sapu@sapu --scope project` from the main checkout of this repo, and stop.
