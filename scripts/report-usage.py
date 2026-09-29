"""How much of each subagent report did the orchestrator use in its next N responses?
Splits reports into sections and checks whether section-specific tokens come back.
  python3 scripts/report-usage.py <session.jsonl> [N]   → logs/report-sections.json"""
import json, os, re, sys, collections
path = sys.argv[1]; N = int(sys.argv[2]) if len(sys.argv) > 2 else 8
TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-/]{5,}|\b[0-9a-f]{7,40}\b|\d{3,}|[가-힣]{3,}")
INTERIM = re.compile(r"I'll (wait|report)|will report|waiting (on|for)|still (running|waiting)|in progress|before reporting", re.I)
def sections(text):
    parts, cur = [], []
    for line in text.split("\n"):
        if re.match(r"^\s*(#{1,6}\s|\*\*[^*]{2,80}\*\*\s*:?\s*$)", line) and cur:
            parts.append("\n".join(cur)); cur = []
        cur.append(line)
    if cur: parts.append("\n".join(cur))
    # no headings: paragraph blocks
    if len(parts) == 1:
        parts = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    return parts
entries = [json.loads(l) for l in open(path) if l.strip()]
entries = [e for e in entries if not e.get("isSidechain")]
rows = []
for i, e in enumerate(entries):
    c = (e.get("message") or {}).get("content")
    if e.get("type") != "user" or not isinstance(c, str) or not c.lstrip().startswith("<task-notification>"): continue
    res = re.search(r"<result>(.*?)</result>", c, re.S)
    if not res: continue
    report = res.group(1).strip()
    if len(report) < 1200 and INTERIM.search(report): continue
    later, ids = [], set()
    for j in range(i + 1, len(entries)):
        x = entries[j]
        if x.get("type") == "system" and x.get("subtype") == "compact_boundary": break
        if x.get("type") != "assistant": continue
        ids.add((x.get("message") or {}).get("id"))
        if len(ids) > N: break
        for b in (x.get("message") or {}).get("content") or []:
            if b.get("type") == "text": later.append(b["text"])
            elif b.get("type") == "tool_use": later.append(json.dumps(b.get("input"), ensure_ascii=False))
    blob = "\n".join(later)
    secs = sections(report)
    counts = collections.Counter(t for s in secs for t in set(TOKEN.findall(s)))
    out = []
    for k, s in enumerate(secs):
        spec = {t for t in set(TOKEN.findall(s)) if counts[t] == 1}
        used = any(t in blob for t in spec) or any(len(l.strip()) >= 30 and l.strip() in blob for l in s.split("\n"))
        out.append({"k": k, "chars": len(s), "used": used, "specific": len(spec), "head": s.strip().split("\n")[0][:80]})
    rows.append({"id": f"{i}", "reportChars": len(report), "sections": out, "report": report})
json.dump(rows, open(os.path.join(os.path.dirname(__file__), "..", "logs", "report-sections.json"), "w"), ensure_ascii=False)
tot = sum(r["reportChars"] for r in rows)
secs = [s for r in rows for s in r["sections"]]
unused = sum(s["chars"] for s in secs if not s["used"])
first_unused = sum(r["sections"][0]["chars"] for r in rows if not r["sections"][0]["used"])
print(f"final reports: {len(rows)} ({tot:,} chars), sections: {len(secs)} (median per report {sorted(len(r['sections']) for r in rows)[len(rows)//2]})")
print(f"sections never referenced in the next {N} orchestrator responses: {sum(1 for s in secs if not s['used'])}/{len(secs)} sections, {100*unused/tot:.0f}% of report chars")
print(f"  of which first sections (usually the summary): {100*first_unused/tot:.0f}% of chars")
print(f"reports with every section referenced: {sum(1 for r in rows if all(s['used'] for s in r['sections']))}/{len(rows)}")
