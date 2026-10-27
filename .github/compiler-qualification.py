"""One-shot frozen-workload experiment; never part of an adoption PR."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path.cwd()
OUT = Path(os.environ["RUNNER_TEMP"]) / "compiler-qualification"
OUT.mkdir()
CACHE = ROOT / ".artifacts/compiler-qualification"
CACHE.mkdir(parents=True)
FIXTURE = ROOT / "scripts/compiler-qualification-negative.mts"
assert not FIXTURE.exists()
assert not os.environ.get("TSRS_BINARY")
records = []
failures = []
configs = {
    "scripts": "tsconfig.scripts.json",
    "core": "tsconfig.core.json",
    "ui": "tsconfig.ui.json",
    "extensions": "tsconfig.extensions.json",
}


def run(label, tool, args):
    started = time.monotonic()
    env = {**os.environ, "OPENCLAW_TYPECHECKER": tool}
    with (OUT / f"{label}.log").open("w") as log:
        result = subprocess.run(
            ["node", "scripts/run-tsgo.mjs", *args, "--pretty", "false"],
            env=env, stdout=log, stderr=subprocess.STDOUT, timeout=390,
        )
    output = (OUT / f"{label}.log").read_text()
    diagnostics = sorted(re.findall(r"^(.+?\(\d+,\d+\): error TS\d+: .*)$", output, re.M))
    record = {
        "label": label, "tool": tool, "seconds": round(time.monotonic() - started, 3),
        "exit": result.returncode, "diagnostics": diagnostics,
    }
    records.append(record)
    (OUT / "results.json").write_text(json.dumps(records, indent=2) + "\n")
    print(json.dumps(record), flush=True)
    return record


def check_clean(record):
    if record["exit"] != 0 or record["diagnostics"]:
        failures.append(f"{record['label']}: expected clean graph")


def project_args(name, cache):
    return ["-p", configs[name], "--incremental", "--tsBuildInfoFile", str(cache)]


def qualify(version, tool):
    for name in configs:
        cache = CACHE / f"{version}-{name}.tsbuildinfo"
        args = project_args(name, cache)
        check_clean(run(f"{version}-{name}-cold", tool, args))
        check_clean(run(f"{version}-{name}-warm", tool, args))
    if version == "tsrs018":
        check_clean(run("tsrs018-cache-from016", tool, project_args("scripts", CACHE / "tsrs016-scripts.tsbuildinfo")))
    args = project_args("scripts", CACHE / f"{version}-scripts.tsbuildinfo")
    try:
        FIXTURE.write_text('export const count: number = "wrong";\ncount.toUpperCase();\nfunction takeNumber(value: number) { return value; }\ntakeNumber("wrong");\n')
        error = run(f"{version}-negative-warm", tool, args)
        codes = set(re.findall(r"TS(\d+):", "\n".join(error["diagnostics"])))
        if error["exit"] == 0 or not {"2322", "2339", "2345"} <= codes:
            failures.append(f"{version}: missing negative diagnostic")
    finally:
        FIXTURE.unlink(missing_ok=True)
    check_clean(run(f"{version}-repair-warm", tool, args))
    # Three references exercise build-mode success, invalidation, and repaired state.
    build = CACHE / version
    build.mkdir()
    for index in range(3):
        project = build / str(index)
        project.mkdir()
        (project / "index.ts").write_text("export const value: number = 1;\n")
        config = {"compilerOptions": {"composite": True, "declaration": True, "emitDeclarationOnly": True, "strict": True, "skipLibCheck": True, "types": []}, "files": ["index.ts"]}
        (project / "tsconfig.json").write_text(json.dumps(config))
    (build / "tsconfig.json").write_text(json.dumps({"files": [], "references": [{"path": str(i)} for i in range(3)]}))
    args = ["-b", str(build / "tsconfig.json"), "--declaration", "true"]
    check_clean(run(f"{version}-build-clean", tool, args))
    source = build / "1/index.ts"
    source.write_text('export const value: number = "wrong";\n')
    error = run(f"{version}-build-error", tool, args)
    if error["exit"] == 0 or not any("TS2322:" in d for d in error["diagnostics"]):
        failures.append(f"{version}: build failed to report error")
    source.write_text("export const value: number = 1;\n")
    check_clean(run(f"{version}-build-repair", tool, args))


try:
    versions = subprocess.check_output(["node", "-e", "console.log(JSON.stringify({tsrs:require('tsrs/package.json').version,typescript:require('typescript/package.json').version,node:process.version}))"], text=True)
    (OUT / "baseline-versions.json").write_text(versions)
    assert json.loads(versions)["tsrs"] == "0.16.0-ts7.1.0-dev.20260929"
    assert json.loads(versions)["typescript"] == "7.1.0-dev.20261016.1"
    qualify("tsrs016", "tsrs")
    qualify("tsgo", "tsgo")
    subprocess.run(["pnpm", "add", "--workspace-root", "--save-dev", "--save-exact", "--lockfile-only", "--ignore-scripts", "tsrs@0.18.0-ts7.1.0-dev.20260929"], check=True, timeout=300)
    diff = subprocess.check_output(["git", "diff", "--", "package.json", "pnpm-lock.yaml"], text=True)
    (OUT / "candidate.patch").write_text(diff)
    subprocess.run(["pnpm", "install", "--frozen-lockfile"], check=True, timeout=420)
    versions = subprocess.check_output(["node", "-e", "console.log(JSON.stringify({tsrs:require('tsrs/package.json').version,typescript:require('typescript/package.json').version,node:process.version}))"], text=True)
    (OUT / "candidate-versions.json").write_text(versions)
    assert json.loads(versions)["tsrs"] == "0.18.0-ts7.1.0-dev.20260929"
    assert json.loads(versions)["typescript"] == "7.1.0-dev.20261016.1"
    qualify("tsrs018", "tsrs")
finally:
    FIXTURE.unlink(missing_ok=True)
    (OUT / "failures.json").write_text(json.dumps(failures, indent=2) + "\n")
    summary = "\n".join(f"| {r['label']} | {r['seconds']} | {r['exit']} | {len(r['diagnostics'])} |" for r in records)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write("Frozen source: `b4bce788b95ae7c2eb568b9712d91c0219083707`\n\n| Run | Seconds | Exit | Diagnostics |\n|---|---:|---:|---:|\n" + summary + "\n\n" + "\n".join(failures))
if failures:
    raise SystemExit("Qualification has failing cases; inspect evidence before adoption.")
