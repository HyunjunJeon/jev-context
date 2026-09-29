"""Dataset for the brief-aware report budget: one row per final subagent report
in a real multi-agent session, with the brief of that round and how much of the
report's distinctive detail the orchestrator used in its next 3/8/20 responses.
  python3 scripts/budget-dataset.py <session.jsonl> > logs/budget-dataset.json"""
import json, os, re, sys

TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-/]{5,}|\b[0-9a-f]{7,40}\b|\d{3,}|[가-힣]{3,}")
INTERIM = re.compile(r"I'll (wait|report)|will report|waiting (on|for)|still (running|waiting)|in progress|before reporting", re.I)
COORD = "The coordinator sent a message while you were working:"

def load(p):
    return [json.loads(l) for l in open(p) if l.strip()]

path = sys.argv[1]
entries = [e for e in load(path) if not e.get("isSidechain")]
subdir = path[:-6] + "/subagents"
rows = []
for i, e in enumerate(entries):
    c = (e.get("message") or {}).get("content")
    if e.get("type") != "user" or not isinstance(c, str) or not c.lstrip().startswith("<task-notification>"):
        continue
    tid = re.search(r"<task-id>([^<]+)</task-id>", c)
    res = re.search(r"<result>(.*?)</result>", c, re.S)
    if not (tid and res):
        continue
    report = res.group(1).strip()
    if len(report) < 1200 and INTERIM.search(report):
        continue
    sub = os.path.join(subdir, f"agent-{tid.group(1)}.jsonl")
    if not os.path.exists(sub):
        continue
    at = e.get("timestamp", "")
    instructions = []
    for x in load(sub):
        t = (x.get("message") or {}).get("content")
        if x.get("type") == "user" and isinstance(t, str) and x.get("timestamp", "") <= at and not t.startswith("[SYSTEM NOTIFICATION"):
            if not instructions or t.startswith(COORD):
                instructions.append(t[len(COORD):].strip() if t.startswith(COORD) else t)
    if not instructions:
        continue
    toks = set(TOKEN.findall(report))
    cov = {}
    for n in (3, 8, 20):
        later, ids = [], set()
        for j in range(i + 1, len(entries)):
            x = entries[j]
            if x.get("type") != "assistant":
                continue
            ids.add((x.get("message") or {}).get("id"))
            if len(ids) > n:
                break
            for b in (x.get("message") or {}).get("content") or []:
                if b.get("type") == "text":
                    later.append(b["text"])
                elif b.get("type") == "tool_use":
                    later.append(json.dumps(b.get("input"), ensure_ascii=False))
        blob = "\n".join(later)
        cov[f"cov{n}"] = round(sum(1 for t in toks if t in blob) / len(toks), 3) if toks else None
    rows.append({"id": f"{tid.group(1)}@{at}", "brief": instructions[-1], "original_brief": instructions[0] if len(instructions) > 1 else None,
                 "round": len(instructions), "report": report, "reportChars": len(report), **cov})
json.dump(rows, sys.stdout, ensure_ascii=False, indent=1)
