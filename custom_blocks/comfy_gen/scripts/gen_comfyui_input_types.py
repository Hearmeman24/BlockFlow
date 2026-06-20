#!/usr/bin/env python3
"""Regenerate the static ComfyUI input-type map used by the _ComfyGen override
detector (sgs-ui-xaqf).

A workflow node's literal value in the API JSON cannot tell INT from FLOAT
(`5` is `5`), so the detector needs the authoritative ComfyUI schema. This
bakes `class_type -> {input_name: "INT"|"FLOAT"|"STRING"|"COMBO"}` from a live
ComfyUI `/object_info` so detection is offline + instant at runtime.

Usage:
    # from a running ComfyUI (default http://localhost:8188)
    python gen_comfyui_input_types.py
    python gen_comfyui_input_types.py --url http://localhost:8188
    # or from a saved /object_info dump
    python gen_comfyui_input_types.py --file object_info.json

Output: custom_blocks/comfy_gen/data/comfyui_input_types.json
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

_PRIMITIVE = {"INT", "FLOAT", "STRING", "BOOLEAN"}
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "comfyui_input_types.json"


def _load(url: str | None, file: str | None) -> dict:
    if file:
        return json.loads(Path(file).read_text())
    with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310 (local/trusted)
        return json.loads(resp.read())


def build_map(object_info: dict) -> dict[str, dict[str, str]]:
    """Reduce /object_info to {class_type: {input_name: type}}.

    type is the ComfyUI INPUT_TYPES tag: a string ("INT"/"FLOAT"/"STRING"/
    "BOOLEAN") for primitives, or "COMBO" when the tag is an enum list. Only
    classes that expose at least one such input are kept.
    """
    out: dict[str, dict[str, str]] = {}
    for cls, spec in object_info.items():
        inputs = spec.get("input", {}) if isinstance(spec, dict) else {}
        fields: dict[str, str] = {}
        for section in ("required", "optional"):
            for name, meta in (inputs.get(section) or {}).items():
                if not isinstance(meta, list) or not meta:
                    continue
                tag = meta[0]
                if isinstance(tag, str) and tag in _PRIMITIVE:
                    fields[name] = tag
                elif isinstance(tag, list):
                    fields[name] = "COMBO"
        if fields:
            out[cls] = fields
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default="http://localhost:8188/object_info")
    ap.add_argument("--file", help="Path to a saved /object_info JSON instead of a live URL")
    args = ap.parse_args()

    object_info = _load(args.url if not args.file else None, args.file)
    type_map = build_map(object_info)
    OUTPUT.write_text(json.dumps(type_map, separators=(",", ":"), sort_keys=True) + "\n")
    print(f"wrote {OUTPUT} — {len(type_map)} classes, {OUTPUT.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
