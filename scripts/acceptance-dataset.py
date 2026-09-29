"""Builds the acceptance-check dataset from a real multi-agent Claude Code session:
one row per subagent report the orchestrator received, with the brief of that
round, the report text, and whether the orchestrator later sent the same agent
a corrective follow-up (and its text, for classification).
  python3 scripts/acceptance-dataset.py <session.jsonl> > logs/acceptance-dataset.json"""
import json, os, re, sys

FIX = re.compile(r"수정|다시|고쳐|누락|빠진|빠졌|틀렸|잘못|fix|redo|missing|again|wrong|incorrect|broken|fail", re.I)
COORD = "The coordinator sent a message while you were working:"

def load(path):
    return [json.loads(l) for l in open(path) if l.strip()]

def main(path):
    entries = [e for e in load(path) if not e.get("isSidechain")]
    subdir = path[:-6] + "/subagents"
    sends = []
    for i, e in enumerate(entries):
        if e.get("type") == "assistant":
            for b in (e.get("message") or {}).get("content") or []:
                if b.get("type") == "tool_use" and b["name"] == "SendMessage":
                    sends.append((i, e.get("timestamp", ""), b["input"]))
    rows = []
    for i, e in enumerate(entries):
        c = (e.get("message") or {}).get("content")
        if e.get("type") != "user" or not isinstance(c, str) or not c.lstrip().startswith("<task-notification>"):
            continue
        tid = re.search(r"<task-id>([^<]+)</task-id>", c)
        res = re.search(r"<result>(.*?)</result>", c, re.S)
        if not (tid and res):
            continue
        agent = tid.group(1)
        sub = os.path.join(subdir, f"agent-{agent}.jsonl")
        if not os.path.exists(sub):
            continue
        at = e.get("timestamp", "")
        instructions = []
        for x in load(sub):
            if x.get("type") == "user" and isinstance((x.get("message") or {}).get("content"), str) and x.get("timestamp", "") <= at:
                t = x["message"]["content"]
                if t.startswith("[SYSTEM NOTIFICATION"):
                    continue
                if not instructions or t.startswith(COORD):
                    instructions.append(t[len(COORD):].strip() if t.startswith(COORD) else t)
        if not instructions:
            continue
        # The next corrective SendMessage to this agent within ~30 orchestrator responses.
        follow = None
        for (j, ts, inp) in sends:
            if j <= i:
                continue
            responses = sum(1 for k in range(i + 1, j) if entries[k].get("type") == "assistant")
            if responses > 30:
                break
            if agent in str(inp.get("to", "")):
                follow = str(inp.get("message", ""))
                break
        rows.append({
            "id": f"{agent}@{at}", "agent": agent,
            "brief": instructions[-1], "original_brief": instructions[0] if len(instructions) > 1 else None,
            "round": len(instructions), "report": res.group(1).strip(),
            "followUp": follow, "fixFollowUp": bool(follow and FIX.search(follow[:600])),
        })
    json.dump(rows, sys.stdout, ensure_ascii=False, indent=1)

main(sys.argv[1])
