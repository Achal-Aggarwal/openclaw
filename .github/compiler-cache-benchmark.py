"""Temporary qualification carrier; never merge this harness or its workflow.

Rule fixed before execution: 5 serial AB pairs per graph/edit; identical diagnostics;
at least 10% median savings including extraction, no p95 regression and no 20%
CPU/RSS regression. Transfer is measured separately, then charged conservatively
in full to each restored invocation. This is a synthetic source transition, not
a replay of the unrecoverable historical DOM change. OS caches are uncontrolled.
"""
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time
import traceback

BASE = "adc889d4215877915268f291c3d4897e2a815844"
ROOT = Path.cwd()
TEMP = Path(os.environ["RUNNER_TEMP"])
OUT = TEMP / "compiler-cache-benchmark"
SEED = TEMP / "compiler-cache-seed"
CACHE = ROOT / ".artifacts/compiler-cache-benchmark"
GRAPHS = {"ui-components": "test/tsconfig/tsconfig.core.test.ui-components.json", "ui-prod": "tsconfig.ui.json"}
EDITS = {
    "ordinary": ("ui/src/lib/format-duration.ts", "Math.floor(ms / 1_000)", "Math.trunc(ms / 1_000)"),
    "global": ("ui/src/components/sidebar-attention-element.ts", "interface HTMLElementTagNameMap {", 'interface HTMLElementTagNameMap {\n    "openclaw-cache-benchmark": HTMLElement;'),
}
OUT.mkdir(exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
records = []


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + "\n")


def host():
    paths = ["/proc/meminfo", "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.events"]
    return {"cpus": os.cpu_count(), "affinity": sorted(os.sched_getaffinity(0)), "load": os.getloadavg(), "resources": {p: Path(p).read_text() for p in paths if Path(p).exists()}}


def identity():
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == BASE
    versions = json.loads(subprocess.check_output(["node", "-e", "console.log(JSON.stringify({tsrs:require('tsrs/package.json').version,node:process.version}))"], text=True))
    assert versions["tsrs"] == "0.16.0-ts7.1.0-dev.20260929"
    assert not os.environ.get("TSRS_BINARY")
    files = ["pnpm-lock.yaml", "package.json", "tsconfig.json", *GRAPHS.values(), *(e[0] for e in EDITS.values())]
    return {"base": BASE, "versions": versions, "inputs": {p: digest((ROOT / p).read_bytes()) for p in files}}


def source_info(cache, source):
    info = json.loads(cache.read_text())
    for name, entry in zip(info["fileNames"], info["fileInfos"]):
        if (cache.parent / name).resolve() == (ROOT / source).resolve():
            if isinstance(entry, str):
                entry = {"version": entry, "signature": entry}
            else:
                entry["signature"] = None if entry.get("noSignature") else entry.get("signature") or entry["version"]
            return {"files": len(info["fileNames"]), **entry}
    raise RuntimeError(f"Mutation source absent from build info: {source}")


def run(graph, label, restoration=0):
    cache = CACHE / f"{graph}.tsbuildinfo"
    metrics = OUT / label
    metrics.mkdir()
    env = {**os.environ, "OPENCLAW_TYPECHECKER": "tsrs", "OPENCLAW_LOCAL_CHECK": "0", "OPENCLAW_TSGO_METRICS_DIR": str(metrics)}
    before = host()
    started = time.monotonic()
    with (OUT / f"{label}.log").open("w") as log:
        completed = subprocess.run(["node", "scripts/run-tsgo.mjs", "-p", GRAPHS[graph], "--incremental", "--tsBuildInfoFile", str(cache.relative_to(ROOT)), "--pretty", "false", "--extendedDiagnostics"], env=env, stdout=log, stderr=subprocess.STDOUT)
    seconds = time.monotonic() - started
    output = (OUT / f"{label}.log").read_text()
    evidence_files = list(metrics.glob("tsgo-*.json"))
    assert len(evidence_files) == 1, f"Missing compiler metrics: {label}"
    evidence = json.loads(evidence_files[0].read_text())
    outcome = evidence["outcome"]
    assert outcome == {"exitCode": completed.returncode, "exitSignal": None, "forwardedSignal": None, "errorCode": None}, outcome
    assert completed.returncode == 0, f"{label}: graph failed; inspect log"
    record = {"label": label, "graph": graph, "wrapperSeconds": seconds, "restoreSeconds": restoration, "totalSeconds": seconds + restoration, "exit": completed.returncode, "diagnostics": re.findall(r"^.*error TS\d+:.*$", output, re.M), "statistics": dict(re.findall(r"^([^:\n]+):\s+([\d.]+(?:[a-zA-Z]+)?)\s*$", output, re.M)), "hostBefore": before, "hostAfter": host(), "metrics": evidence, "sources": {name: source_info(cache, edit[0]) for name, edit in EDITS.items()}}
    assert not record["diagnostics"], record["diagnostics"]
    records.append(record)
    save("results.json", records)
    print(json.dumps({k: record[k] for k in ["label", "wrapperSeconds", "restoreSeconds", "totalSeconds", "exit", "statistics"]}), flush=True)
    return record


def summarize(values):
    values = sorted(values)
    return {"median": statistics.median(values), "p95": values[math.ceil(len(values) * .95) - 1], "min": values[0], "max": values[-1], "samples": len(values)}


def main():
    current = identity()
    save("identity.json", current)
    save("host.json", host())
    if sys.argv[1] == "seed":
        SEED.mkdir()
        seed = {"identity": current, "graphs": {}}
        for graph in GRAPHS:
            cache = CACHE / f"{graph}.tsbuildinfo"
            cache.unlink(missing_ok=True)
            result = run(graph, f"seed-{graph}")
            data = gzip.compress(cache.read_bytes(), mtime=0)
            (SEED / f"{graph}.gz").write_bytes(data)
            seed["graphs"][graph] = {"sha256": digest(data), "bytes": len(data), "sources": result["sources"]}
        (SEED / "seed.json").write_text(json.dumps(seed, indent=2) + "\n")
        return
    assert sys.argv[1] == "compare"
    transfer = time.time() - float((TEMP / "compiler-cache-transfer-start").read_text())
    seed = json.loads((SEED / "seed.json").read_text())
    assert seed["identity"] == current, "Producer and consumer inputs differ"
    save("transfer.json", {"seconds": transfer, "scope": "artifact download action plus step overhead; one sample, not Actions cache service"})
    originals = {name: (ROOT / edit[0]).read_bytes() for name, edit in EDITS.items()}
    summaries = []
    try:
        for scenario, (filename, old, new) in EDITS.items():
            source = ROOT / filename
            text = originals[scenario].decode()
            assert text.count(old) == 1
            source.write_text(text.replace(old, new))
            save(f"{scenario}-transition.json", {"base": BASE, "path": filename, "beforeSha256": digest(originals[scenario]), "afterSha256": digest(source.read_bytes()), "patch": subprocess.check_output(["git", "diff", "--", filename], text=True)})
            for graph in GRAPHS:
                cache = CACHE / f"{graph}.tsbuildinfo"
                compressed = (SEED / f"{graph}.gz").read_bytes()
                assert digest(compressed) == seed["graphs"][graph]["sha256"]
                groups = {"cold": [], "restored": []}
                for iteration in range(5):
                    for mode in groups:
                        cache.unlink(missing_ok=True)
                        started = time.monotonic()
                        if mode == "restored":
                            cache.write_bytes(gzip.decompress(compressed))
                        restoration = time.monotonic() - started if mode == "restored" else 0
                        result = run(graph, f"{scenario}-{graph}-{iteration}-{mode}", restoration)
                        groups[mode].append(result)
                        assert result["sources"][scenario]["version"] != seed["graphs"][graph]["sources"][scenario]["version"], "Edited source was not invalidated"
                        if scenario == "global":
                            assert result["sources"][scenario].get("affectsGlobalScope"), "DOM edit did not affect global scope"
                            if mode == "restored":
                                signature = result["sources"][scenario]["signature"]
                                baseline_signature = seed["graphs"][graph]["sources"][scenario]["signature"]
                                assert signature, "Restored DOM edit did not compute a declaration signature"
                                if baseline_signature:
                                    assert signature != baseline_signature, "DOM declaration signature did not change"
                    assert groups["cold"][-1]["diagnostics"] == groups["restored"][-1]["diagnostics"]
                row = {"scenario": scenario, "graph": graph, "cold": summarize([r["totalSeconds"] for r in groups["cold"]]), "restored": summarize([r["totalSeconds"] for r in groups["restored"]]), "restoredWithTransfer": summarize([r["totalSeconds"] + transfer for r in groups["restored"]])}
                for metric in ["cpuMs", "peakRssBytes"]:
                    row[metric] = {mode: summarize([r["metrics"]["resources"][metric] for r in runs]) for mode, runs in groups.items()}
                row["passesRule"] = row["restoredWithTransfer"]["median"] <= row["cold"]["median"] * .9 and row["restoredWithTransfer"]["p95"] <= row["cold"]["p95"] and all(row[m]["restored"]["median"] < row[m]["cold"]["median"] * 1.2 for m in ["cpuMs", "peakRssBytes"])
                summaries.append(row)
                save("summary.json", summaries)
                print(json.dumps(row), flush=True)
            source.write_bytes(originals[scenario])
    finally:
        for name, (filename, _, _) in EDITS.items():
            (ROOT / filename).write_bytes(originals[name])
    assert len(records) == 40
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write("## Compiler cache qualification\n\nFrozen workload: `" + BASE + "`\n\n```json\n" + json.dumps(summaries, indent=2) + "\n```\n\nTransfer is an artifact-service observation, not an Actions cache-service benchmark. CPU/RSS are sampled lower bounds. No rollout is authorized by this result.\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        print("[compiler-cache-benchmark] FAILED (exit 1)", file=sys.stderr)
        sys.exit(1)
