// Claude Code PostToolUse(Bash): replace the output the model is about to see.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pruneOutput } from '../core/prune.mjs';
import { saveText } from '../core/io.mjs';
import { conversation, goalOf, readEntries } from '../transcript/claude.mjs';

// Claude Code's preview of an output it saved to a file: its path plus
// ~2,114 chars of header and first lines (measured on 2.1.284). A pruned
// output must not cost the model more than that preview did.
const PREVIEW_OVERHEAD = 2_100;

export async function postToolUse(cfg, event) {
  const entry = { decision: 'off' };
  if (cfg.prune === 'off') return { entry };
  const record = event.tool_response;
  const command = event.tool_input?.command ?? '';
  entry.decision = 'not_applicable';
  if (event.tool_name !== 'Bash' || !record || record.interrupted || typeof record.stdout !== 'string') return { entry };
  entry.decision = 'archive_recovery';
  if (command.includes('/tool-results/') || command.includes('/jev-context/')) return { entry };

  const persisted = record.persistedOutputPath;
  const output = persisted ? readFileSync(persisted, 'utf8') : record.stdout;
  const id = event.tool_use_id ?? createHash('sha256').update(`${event.session_id}:${command}:${output.length}`).digest('hex').slice(0, 16);
  const archivePath = persisted ?? join(dirname(event.transcript_path ?? cfg.stateDir), String(event.session_id ?? 'session'), 'jev-context', `${id}.txt`);
  const result = await pruneOutput(cfg, {
    command,
    output,
    context: () => {
      const { messages } = conversation(readEntries(event.transcript_path));
      return { goal: goalOf(messages), messages };
    },
    budget: persisted ? Math.min(cfg.pruneMaxChars, persisted.length + PREVIEW_OVERHEAD) : Infinity,
    archivePath,
    saveOriginal: persisted ? undefined : (text) => {
      try {
        saveText(archivePath, text);
        return true;
      } catch {
        return false;
      }
    },
  });
  Object.assign(entry, { decision: result.stage, sourceChars: result.sourceChars, visibleChars: result.visibleChars, persisted: Boolean(persisted), jevRequests: result.jevRequests, jevDecision: result.jevDecision, jevError: result.jevError });
  if (!result.text) return { entry };
  // Must stay a Bash output object: Claude Code silently ignores a plain string.
  const { persistedOutputPath, persistedOutputSize, ...rest } = record;
  return {
    entry,
    output: { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...rest, stdout: result.text, stderr: persisted ? '' : record.stderr ?? '' } } },
  };
}
