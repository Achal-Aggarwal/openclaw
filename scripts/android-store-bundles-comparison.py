#!/usr/bin/env python3
"""Build-only Android A/B workload; exists only on the diagnostic branch."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import threading
import time


ROOT = Path.cwd()
ANDROID = ROOT / "apps/android"
OUT = Path(os.environ["PROOF_DIR"])
FIXTURE = ROOT / "scripts/fixtures/android-store-bundles"
ARTIFACT = os.environ["COMPARISON_ARTIFACT"]
STAMP = "2026-10-27T00:00:00Z"
ALLOWED_DIAGNOSTIC_PATHS = {
    ".github/workflows/android-store-release.yml",
    ".github/workflows/android-build-comparison-sample.yml",
    "apps/android/Config/ReleaseSigning.json",
    "apps/android/scripts/build-release-artifacts.ts",
    "scripts/android-store-bundles-comparison.py",
    "scripts/fixtures/android-store-bundles/fixture.p12.base64",
    "scripts/fixtures/android-store-bundles/certificate-sha256.txt",
    "scripts/fixtures/android-store-bundles/README.md",
}
RESET_DIRECTORIES = [
    "apps/android/.gradle",
    "apps/android/build",
    "apps/android/app/build",
    "apps/android/wear/build",
    "apps/android/wear-shared/build",
    "apps/android/benchmark/build",
    "apps/shared/mermaid/assets/mermaid",
]
BUILD_DAEMON_CLASSES = {
    "org.gradle.launcher.daemon.bootstrap.GradleDaemon",
    "org.jetbrains.kotlin.daemon.KotlinCompileDaemon",
}


def git(*args):
    return subprocess.check_output(["git", *args], text=True, cwd=ROOT).strip()


def host_sample():
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        name, value = line.split(":", 1)
        if name in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
            memory[name + "KiB"] = int(value.split()[0])
    cpu = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
    return {
        "monotonicSeconds": time.monotonic(),
        "loadAverage": list(os.getloadavg()),
        "memory": memory,
        "cpuJiffies": [int(value) for value in cpu],
    }


def reset_generated_outputs():
    started = time.monotonic()
    paths = []
    for relative in RESET_DIRECTORIES:
        if git("ls-files", "--", relative):
            raise ValueError("Refusing to reset tracked files under " + relative)
        directory = ROOT / relative
        if directory.is_symlink():
            raise ValueError("Refusing to reset a symlink at " + relative)
        if directory.exists():
            ignored = subprocess.run(["git", "check-ignore", "--quiet", "--", relative], cwd=ROOT)
            if ignored.returncode != 0 or not directory.is_dir():
                raise ValueError("Reset scope is not an ignored generated directory: " + relative)
            shutil.rmtree(directory)
            paths.append({"path": relative, "result": "removed"})
        else:
            paths.append({"path": relative, "result": "absent"})
    return {"elapsedSeconds": time.monotonic() - started, "paths": paths}


def build_daemons():
    output = subprocess.check_output(["jps", "-l"], text=True, timeout=15)
    return {
        int(pid): name
        for pid, name in (line.split(maxsplit=1) for line in output.splitlines() if " " in line)
        if name in BUILD_DAEMON_CLASSES
    }


def stop_owned_daemons(proof, env, initial_daemons):
    proof["daemonStop"] = measured_run("gradle-stop", ["./gradlew", "--stop"], env, ANDROID)
    if proof["daemonStop"]["exitStatus"] != 0:
        raise RuntimeError("Gradle daemon stop failed; inspect gradle-stop.log")
    # Kotlin can outlive the Gradle client; keep its retained heap out of the next sample.
    cleanup_started = time.monotonic()
    owned = {pid: name for pid, name in build_daemons().items() if pid not in initial_daemons}
    proof["daemonStop"]["remainingOwnedDaemons"] = owned
    for pid in owned:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 15
    while any(Path(f"/proc/{pid}").exists() for pid in owned):
        if time.monotonic() >= deadline:
            raise RuntimeError("Owned build daemon did not exit before the next sample")
        time.sleep(0.2)
    proof["daemonStop"]["ownedDaemonsExited"] = True
    proof["daemonStop"]["ownedDaemonCleanupSeconds"] = time.monotonic() - cleanup_started


def measured_run(name, command, env, cwd):
    log_path = OUT / (name + ".log")
    time_path = OUT / (name + "-time.txt")
    samples = []
    stop = threading.Event()

    def sample_host():
        while not stop.is_set():
            samples.append(host_sample())
            stop.wait(5)

    monitor = threading.Thread(target=sample_host, daemon=True)
    monitor.start()
    started = time.monotonic()
    print(f"Starting {name}: {ARTIFACT}", flush=True)
    try:
        with log_path.open("w") as log:
            result = subprocess.run(
                [
                    "/usr/bin/time", "-o", str(time_path), "-f",
                    "wallSeconds=%e\nuserSeconds=%U\nsystemSeconds=%S\nmaxRssKiB=%M\nexitStatus=%x",
                    *command,
                ],
                cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
            )
        elapsed = time.monotonic() - started
    finally:
        stop.set()
        monitor.join()
    samples.append(host_sample())
    timing = {}
    for line in time_path.read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            timing[key] = float(value)
    print(f"Finished {name}: status={result.returncode}, wall={elapsed:.3f}s", flush=True)
    return {
        "elapsedSeconds": elapsed,
        "exitStatus": result.returncode,
        "controllerAndChildrenTiming": timing,
        "hostSamples": samples,
    }


def main(proof):
    if ARTIFACT not in {"all", "store"}:
        raise ValueError("Comparison artifact must be all or store")
    head = git("rev-parse", "HEAD")
    production = os.environ["PRODUCTION_SHA"]
    if not re.fullmatch(r"[a-f0-9]{40}", production):
        raise ValueError("Production source must be a full lowercase SHA")
    if head != os.environ["GITHUB_SHA"]:
        raise ValueError("Diagnostic HEAD does not match workflow SHA")
    changed = set(git("diff", "--name-only", production, head).splitlines())
    if not changed.issubset(ALLOWED_DIAGNOSTIC_PATHS):
        raise ValueError("Diagnostic branch changed production files outside the allowed fixture/harness paths")
    helper_path = "apps/android/scripts/build-release-artifacts.ts"
    production_helper = subprocess.check_output(["git", "show", production + ":" + helper_path], cwd=ROOT, text=True)
    diagnostic_helper = (ROOT / helper_path).read_text()
    profile_marker = '    [\n      "--profile",\n      ...androidBuildMetadataGradleArgs(buildMetadata),'
    original_marker = '    [\n      ...androidBuildMetadataGradleArgs(buildMetadata),'
    if diagnostic_helper.count(profile_marker) != 1 or diagnostic_helper.replace(profile_marker, original_marker) != production_helper:
        raise ValueError("Diagnostic helper differs from production by more than the single --profile argument")
    if git("status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Comparison requires a clean diagnostic checkout")
    if Path(os.environ["GRADLE_USER_HOME"]).exists():
        raise ValueError("Each comparison mode requires a never-used Gradle user home")

    proof.update({
        "productionSha": production,
        "diagnosticSha": head,
        "diagnosticChangedPaths": sorted(changed),
        "pair": int(os.environ["COMPARISON_PAIR"]),
        "sample": int(os.environ["COMPARISON_PAIR"]) * 2 - (1 if ARTIFACT == "all" else 0),
        "artifactSelection": ARTIFACT,
        "condition": "same-host pair; cold Gradle user home and project/generated outputs; shared OS, Android SDK and frozen Node dependencies; signing preflight retained",
        "runner": {key: os.environ.get(key) for key in [
            "RUNNER_NAME", "RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion",
        ]},
        "cpuCount": os.cpu_count(),
        "cpuModel": next(line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")),
        "hostBefore": host_sample(),
        "timingLimit": "GNU time CPU/RSS covers the controller and waited-for children; the detached Gradle daemon is covered by host samples, not these process metrics.",
    })
    proof["reset"] = reset_generated_outputs()

    keystore = Path(os.environ["RUNNER_TEMP"]) / "android-comparison-fixture.p12"
    keystore.write_bytes(base64.b64decode((FIXTURE / "fixture.p12.base64").read_text(), validate=False))
    keystore.chmod(0o600)
    fingerprint = (FIXTURE / "certificate-sha256.txt").read_text().strip()
    manifest = json.loads((ANDROID / "Config/ReleaseSigning.json").read_text())
    if manifest["apkCertificateSha256"] != fingerprint:
        raise ValueError("Diagnostic signing manifest does not pin the synthetic fixture")
    certificate = subprocess.check_output([
        "keytool", "-list", "-v", "-storetype", "PKCS12", "-keystore", str(keystore),
        "-storepass", "android", "-alias", "comparison",
    ], text=True, env={**os.environ, "LC_ALL": "C", "LANG": "C"})
    actual_pin = re.search(r"SHA256:\s*([A-Fa-f0-9:]+)", certificate)
    if actual_pin is None or actual_pin[1].replace(":", "").lower() != fingerprint:
        raise ValueError("Synthetic fixture certificate does not match its pin")
    proof["fixtureCertificateSha256"] = fingerprint

    env = {
        **os.environ,
        "GIT_COMMIT": head,
        "OPENCLAW_BUILD_TIMESTAMP": STAMP,
        "LC_ALL": "C",
        "LANG": "C",
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_FILE": str(keystore),
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_STORE_PASSWORD": "android",
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_ALIAS": "comparison",
        "ORG_GRADLE_PROJECT_OPENCLAW_ANDROID_KEY_PASSWORD": "android",
    }
    for key in ["OPENCLAW_ANDROID_RELEASE_PLAN", "GIT_SHA", "GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]:
        env.pop(key, None)
    initial_daemons = build_daemons()
    proof["initialBuildDaemons"] = initial_daemons
    try:
        proof["signingPreflight"] = measured_run("signing-preflight", [
            "./gradlew", ":app:validateSigningPlayRelease", ":wear:validateSigningRelease",
            "-PopenclawBuildCommit=" + head, "-PopenclawBuildTimestamp=" + STAMP,
        ], env, ANDROID)
        if proof["signingPreflight"]["exitStatus"] != 0:
            raise RuntimeError("Signing preflight failed; inspect signing-preflight.log")

        proof["build"] = measured_run("build", [
            "bun", "apps/android/scripts/build-release-artifacts.ts", "--artifact", ARTIFACT,
        ], env, ROOT)
        if proof["build"]["exitStatus"] != 0:
            raise RuntimeError("Artifact build failed; inspect build.log")
    finally:
        stop_owned_daemons(proof, env, initial_daemons)

    log = (OUT / "build.log").read_text()
    tasks = re.findall(r"^> Task (:\S+)([^\n]*)$", log, re.MULTILINE)
    executed = [task for task, state in tasks if not any(marker in state for marker in ["UP-TO-DATE", "FROM-CACHE", "NO-SOURCE", "SKIPPED"])]
    third_party = [task for task in executed if "ThirdPartyRelease" in task]
    selected = re.findall(r"^Gradle task: (.+)$", log, re.MULTILINE)
    expected_tasks = [":wear:bundleRelease", ":app:bundlePlayRelease"]
    if ARTIFACT == "all":
        expected_tasks.append(":app:assembleThirdPartyRelease")
    if selected != expected_tasks:
        raise ValueError("Helper selected an unexpected Gradle task set")
    if (ARTIFACT == "store" and third_party) or (ARTIFACT == "all" and not third_party):
        raise ValueError("Executed third-party tasks violate the selected artifact contract")
    proof["tasks"] = {"selected": selected, "reportedCount": len(tasks), "executedCount": len(executed), "executedThirdParty": third_party}

    version = json.loads((ANDROID / "version.json").read_text())["version"]
    expected = [f"openclaw-{version}-{flavor}-release.aab" for flavor in ["wear", "play"]]
    if ARTIFACT == "all":
        expected.append(f"openclaw-{version}-third-party-release.apk")
    artifacts_dir = ANDROID / "build/release-artifacts"
    expected_files = set(expected + [name + ".sha256" for name in expected])
    if {file.name for file in artifacts_dir.iterdir()} != expected_files:
        raise ValueError("Output directory does not contain exactly the expected artifacts and checksums")
    proof["artifacts"] = []
    for name in expected:
        file = artifacts_dir / name
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        if (artifacts_dir / (name + ".sha256")).read_text() != f"{digest}  {name}\n":
            raise ValueError("Artifact SHA-256 sidecar does not match")
        proof["artifacts"].append({"name": name, "bytes": file.stat().st_size, "sha256": digest})
    profiles = ANDROID / "build/reports/profile"
    if not profiles.is_dir():
        raise ValueError("Measured Gradle build did not generate its local profile")
    shutil.copytree(profiles, OUT / "gradle-profile")
    proof["hostAfter"] = host_sample()
    proof["status"] = "passed"


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=False)
    result = {"schemaVersion": 1, "status": "failed"}
    try:
        main(result)
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        (OUT / "proof.json").write_text(json.dumps(result, indent=2) + "\n")
