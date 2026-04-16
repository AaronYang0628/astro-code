#!/usr/bin/env python3

import argparse
import json
from pathlib import Path


def _to_float(value):
    try:
        return float(value)
    except Exception:
        return None


def _load_rows(input_path: Path):
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("Input JSON must be a list of objects")
    rows = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        obj_id = str(item.get("object_id", "")).strip()
        ra = _to_float(item.get("ra_deg"))
        dec = _to_float(item.get("dec_deg"))
        if obj_id and ra is not None and dec is not None:
            rows.append({"object_id": obj_id, "ra_deg": ra, "dec_deg": dec})
    return rows


def _resolve_with_desiutil(rows):
    from desiutil.brick import Bricks  # type: ignore

    bricks = Bricks()
    out = []
    for row in rows:
        ra = row["ra_deg"]
        dec = row["dec_deg"]
        brickid = bricks.brickid(ra, dec)
        brickname = bricks.brickname(ra, dec)
        out.append(
            {
                "object_id": row["object_id"],
                "ra_deg": ra,
                "dec_deg": dec,
                "brickid": int(brickid) if brickid is not None else None,
                "brickname": str(brickname) if brickname is not None else None,
                "status": "ok",
            }
        )
    return out


def main():
    parser = argparse.ArgumentParser(
        description="Compute DESI brickid/brickname from RA/DEC"
    )
    parser.add_argument(
        "--input-json",
        required=True,
        help="Input JSON list of {object_id,ra_deg,dec_deg}",
    )
    args = parser.parse_args()

    input_path = Path(args.input_json)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    rows = _load_rows(input_path)

    backend = "desiutil"
    error_message = None
    try:
        resolved = _resolve_with_desiutil(rows)
    except Exception as exc:
        backend = "unavailable"
        error_message = str(exc)
        resolved = []
        for row in rows:
            resolved.append(
                {
                    "object_id": row["object_id"],
                    "ra_deg": row["ra_deg"],
                    "dec_deg": row["dec_deg"],
                    "brickid": None,
                    "brickname": None,
                    "status": "error",
                    "error": error_message,
                }
            )

    output = {
        "backend": backend,
        "error": error_message,
        "rows": resolved,
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()
