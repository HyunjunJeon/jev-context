---
name: jev-context
description: Run a noisy build, test, install or lint command through Jev context pruning so its repetitive output does not fill the context window. Use when automatic wrapping (JEV_CONTEXT_CODEX_WRAP=on) is off.
---

Resolve the plugin root as three directories above this skill's directory.

For a non-interactive command that prints a long, repetitive log (build, test,
install, lint), run it through the plugin's runner with the ordinary shell tool:

```sh
node "<plugin-root>/bin/codex-run.mjs" -- npm run build
```

The runner executes the command with `bash -lc`, forwards stderr unchanged and
exits with the command's own status. Its stdout is folded where lines repeat
(and, only with both `TYPESAFE_API_KEY` and `JEV_CONTEXT_JEV=live` set, trimmed by Jev); the full output is saved
first under `.jev-context/outputs/` in the working directory, and the last
line of the pruned output names that file. Read or search it when you need an
omitted line. Diagnostics, results and lines that differ from their neighbours
are always kept.

Run the command directly instead for interactive or TTY programs, servers,
commands whose live progress matters, and commands that print a file, a diff
or structured data you need whole. If the working directory is read-only the
runner cannot save the original and passes the output through unchanged.
