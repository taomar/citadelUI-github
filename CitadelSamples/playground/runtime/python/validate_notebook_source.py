"""Compile protected notebook cell files without executing them."""

from __future__ import annotations

import ast
import hashlib
import json
import sys
from pathlib import Path


SCENARIO = "offline-python-source-validation"


def _read_manifest(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or payload.get("scenario") != SCENARIO:
        raise ValueError("unsupported validation manifest")
    if not isinstance(payload.get("sampleId"), str) or not payload["sampleId"]:
        raise ValueError("manifest sampleId is required")
    if not isinstance(payload.get("cells"), list) or not payload["cells"]:
        raise ValueError("manifest must contain at least one code cell")
    return payload


def _compile_cell(base: Path, entry: dict) -> dict:
    index = entry.get("cellIndex")
    file_name = entry.get("fileName")
    if not isinstance(index, int) or not isinstance(file_name, str):
        raise ValueError("invalid cell manifest entry")
    if Path(file_name).name != file_name or not file_name.endswith(".py"):
        raise ValueError("cell file name must be a direct .py child")

    source_bytes = (base / file_name).read_bytes()
    sha256 = hashlib.sha256(source_bytes).hexdigest()
    if len(source_bytes) != entry.get("bytes") or sha256 != entry.get("sha256"):
        return {
            "id": f"cell-{index}-python-syntax",
            "cellIndex": index,
            "passed": False,
            "bytes": len(source_bytes),
            "sha256": sha256,
            "detail": "The workspace source did not match the server-extracted notebook bytes.",
        }

    try:
        source = source_bytes.decode("utf-8")
        compile(
            source,
            f"<notebook-cell-{index}>",
            "exec",
            flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
            dont_inherit=True,
        )
        return {
            "id": f"cell-{index}-python-syntax",
            "cellIndex": index,
            "passed": True,
            "bytes": len(source_bytes),
            "sha256": sha256,
            "detail": "Python compiled the exact source without executing it.",
        }
    except (SyntaxError, UnicodeDecodeError) as error:
        return {
            "id": f"cell-{index}-python-syntax",
            "cellIndex": index,
            "passed": False,
            "bytes": len(source_bytes),
            "sha256": sha256,
            "detail": f"{error.__class__.__name__}: {error}",
        }


def main() -> int:
    if len(sys.argv) != 3:
        raise ValueError("expected manifest and report paths")
    manifest_path = Path(sys.argv[1]).resolve()
    report_path = Path(sys.argv[2]).resolve()
    if manifest_path.parent != report_path.parent:
        raise ValueError("manifest and report must share one workspace directory")

    manifest = _read_manifest(manifest_path)
    checks = [_compile_cell(manifest_path.parent, entry) for entry in manifest["cells"]]
    passed = all(check["passed"] for check in checks)
    report = {
        "schemaVersion": 1,
        "scenario": SCENARIO,
        "sampleId": manifest["sampleId"],
        "state": "passed" if passed else "failed",
        "validation": "python-compile-only",
        "sourceExecuted": False,
        "azureContacted": False,
        "networkContacted": False,
        "liveEvidence": False,
        "checks": checks,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"state": report["state"], "compiledCells": len(checks)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"{error.__class__.__name__}: {error}", file=sys.stderr)
        raise SystemExit(2)
