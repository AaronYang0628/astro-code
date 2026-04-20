#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from cutout.core import cutout_image_objlist  # noqa: E402


RA_KEYS = [
    "RIGHT_ASCENSION",
    "right_ascension",
    "ra_deg",
    "RA",
    "ra",
]

DEC_KEYS = [
    "DECLINATION",
    "declination",
    "dec_deg",
    "DEC",
    "dec",
]

OBJ_KEYS = ["obj_id", "object_id", "euclid_object_id", "desi_object_id"]
TILE_KEYS = ["tile_index", "tile_id", "TILE_INDEX", "TILEID"]
BRICK_KEYS = ["brickname", "BRICKNAME"]


@dataclass
class CutoutTask:
    row_index: int
    obj_id: str
    tile_index: str | None
    brickname: str | None
    ra_deg: float
    dec_deg: float
    telescope: str
    band: str
    src_path: str
    local_path: str


def _to_float(value: object) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    try:
        parsed = float(text)
    except Exception:
        return None
    return parsed if parsed == parsed else None


def _first_nonempty(row: dict[str, object], keys: Iterable[str]) -> str | None:
    for key in keys:
        val = row.get(key)
        if val is None:
            continue
        text = str(val).strip()
        if text:
            return text
    return None


def _find_coord(row: dict[str, object], keys: Iterable[str]) -> float | None:
    for key in keys:
        if key not in row:
            continue
        value = _to_float(row.get(key))
        if value is not None:
            return value
    return None


def _safe_token(value: str | None, default: str) -> str:
    if value is None:
        return default
    text = value.strip()
    if not text:
        return default
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)


def _parse_path_maps(path_maps: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for entry in path_maps:
        if "=" not in entry:
            raise ValueError(f"Invalid --path-map '{entry}', expected SRC=DST")
        src, dst = entry.split("=", 1)
        src = src.strip()
        dst = dst.strip()
        if not src or not dst:
            raise ValueError(f"Invalid --path-map '{entry}', expected SRC=DST")
        out.append((src, dst))
    return out


def _resolve_local_path(src_path: str, path_maps: list[tuple[str, str]]) -> str | None:
    if "*" in src_path:
        return None

    direct = Path(src_path)
    if direct.exists():
        return str(direct)

    for src_prefix, dst_prefix in path_maps:
        if src_path.startswith(src_prefix):
            replaced = dst_prefix + src_path[len(src_prefix) :]
            candidate = Path(replaced)
            if candidate.exists():
                return str(candidate)

    return None


def _build_tasks(
    rows: list[dict[str, object]],
    desi_bands: list[str],
    path_maps: list[tuple[str, str]],
    limit_rows: int,
) -> tuple[list[CutoutTask], list[dict[str, object]]]:
    tasks: list[CutoutTask] = []
    rejected: list[dict[str, object]] = []

    for idx, row in enumerate(rows):
        if limit_rows > 0 and idx >= limit_rows:
            break

        ra_deg = _find_coord(row, RA_KEYS)
        dec_deg = _find_coord(row, DEC_KEYS)
        if ra_deg is None or dec_deg is None:
            rejected.append(
                {
                    "row_index": idx,
                    "reason": "missing_radec",
                    "obj_id": _first_nonempty(row, OBJ_KEYS),
                }
            )
            continue

        obj_id = _first_nonempty(row, OBJ_KEYS) or f"row_{idx}"
        tile_index = _first_nonempty(row, TILE_KEYS)
        brickname = _first_nonempty(row, BRICK_KEYS)

        euclid_path = _first_nonempty(
            row, ["euclid_fits_path", "euclid_vis_path_pattern"]
        )
        if euclid_path:
            local = _resolve_local_path(euclid_path, path_maps)
            if local:
                tasks.append(
                    CutoutTask(
                        row_index=idx,
                        obj_id=obj_id,
                        tile_index=tile_index,
                        brickname=brickname,
                        ra_deg=ra_deg,
                        dec_deg=dec_deg,
                        telescope="euclid",
                        band="vis",
                        src_path=euclid_path,
                        local_path=local,
                    )
                )
            else:
                rejected.append(
                    {
                        "row_index": idx,
                        "reason": "euclid_path_unresolved",
                        "obj_id": obj_id,
                        "path": euclid_path,
                    }
                )

        for band in desi_bands:
            key = f"desi_image_{band}_path"
            desi_path = _first_nonempty(row, [key])
            if not desi_path:
                continue
            local = _resolve_local_path(desi_path, path_maps)
            if local:
                tasks.append(
                    CutoutTask(
                        row_index=idx,
                        obj_id=obj_id,
                        tile_index=tile_index,
                        brickname=brickname,
                        ra_deg=ra_deg,
                        dec_deg=dec_deg,
                        telescope="desi",
                        band=band,
                        src_path=desi_path,
                        local_path=local,
                    )
                )
            else:
                rejected.append(
                    {
                        "row_index": idx,
                        "reason": f"desi_{band}_path_unresolved",
                        "obj_id": obj_id,
                        "path": desi_path,
                    }
                )

    return tasks, rejected


def _read_csv_rows(csv_path: Path) -> list[dict[str, object]]:
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return [dict(row) for row in reader]


def _group_tasks(tasks: list[CutoutTask]):
    grouped: dict[tuple[str, str, str], list[CutoutTask]] = defaultdict(list)
    for task in tasks:
        grouped[(task.telescope, task.band, task.local_path)].append(task)
    return grouped


def _output_file_path(
    output_dir: Path, task: CutoutTask, idx_within_group: int
) -> Path:
    telescope_dir = output_dir / task.telescope / task.band
    telescope_dir.mkdir(parents=True, exist_ok=True)

    obj_token = _safe_token(task.obj_id, f"row_{task.row_index}")
    tile_token = _safe_token(task.tile_index, "tile_na")
    brick_token = _safe_token(task.brickname, "brick_na")
    filename = (
        f"row{task.row_index:06d}"
        f"_obj_{obj_token}"
        f"_tile_{tile_token}"
        f"_brick_{brick_token}"
        f"_{task.telescope}_{task.band}"
        f"_{idx_within_group:03d}.fits"
    )
    return telescope_dir / filename


def _write_index_csv(index_path: Path, records: list[dict[str, object]]) -> None:
    headers = [
        "row_index",
        "obj_id",
        "tile_index",
        "brickname",
        "ra_deg",
        "dec_deg",
        "telescope",
        "band",
        "input_path",
        "resolved_path",
        "output_path",
        "status",
        "message",
        "has_overlap",
        "x",
        "y",
        "xmin",
        "xmax",
        "ymin",
        "ymax",
        "stamp_size_px",
    ]

    with index_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for record in records:
            writer.writerow(record)


def run_cutout(
    input_csv: Path,
    output_dir: Path,
    size_deg: float,
    fill_value: float,
    desi_bands: list[str],
    path_maps: list[tuple[str, str]],
    limit_rows: int,
) -> dict[str, object]:
    rows = _read_csv_rows(input_csv)
    tasks, rejected = _build_tasks(
        rows, desi_bands=desi_bands, path_maps=path_maps, limit_rows=limit_rows
    )
    grouped = _group_tasks(tasks)

    output_dir.mkdir(parents=True, exist_ok=True)
    index_records: list[dict[str, object]] = []
    success_count = 0
    failed_count = 0

    for (telescope, band, local_path), group_tasks in grouped.items():
        try:
            cutouts, metas = cutout_image_objlist(
                [task.ra_deg for task in group_tasks],
                [task.dec_deg for task in group_tasks],
                local_path,
                size_deg=size_deg,
                device="Euclid" if telescope == "euclid" else "DESI",
                fill_value=fill_value,
                return_meta=True,
            )
        except Exception as exc:
            failed_count += len(group_tasks)
            message = str(exc)
            for task in group_tasks:
                index_records.append(
                    {
                        "row_index": task.row_index,
                        "obj_id": task.obj_id,
                        "tile_index": task.tile_index,
                        "brickname": task.brickname,
                        "ra_deg": task.ra_deg,
                        "dec_deg": task.dec_deg,
                        "telescope": task.telescope,
                        "band": task.band,
                        "input_path": task.src_path,
                        "resolved_path": task.local_path,
                        "output_path": "",
                        "status": "error",
                        "message": message,
                        "has_overlap": "",
                        "x": "",
                        "y": "",
                        "xmin": "",
                        "xmax": "",
                        "ymin": "",
                        "ymax": "",
                        "stamp_size_px": "",
                    }
                )
            continue

        for idx_in_group, (task, cutout, meta) in enumerate(
            zip(group_tasks, cutouts, metas)
        ):
            out_path = _output_file_path(output_dir, task, idx_in_group)
            try:
                cutout.writeto(out_path, overwrite=True)
                success_count += 1
                index_records.append(
                    {
                        "row_index": task.row_index,
                        "obj_id": task.obj_id,
                        "tile_index": task.tile_index,
                        "brickname": task.brickname,
                        "ra_deg": task.ra_deg,
                        "dec_deg": task.dec_deg,
                        "telescope": task.telescope,
                        "band": task.band,
                        "input_path": task.src_path,
                        "resolved_path": task.local_path,
                        "output_path": str(out_path),
                        "status": "ok",
                        "message": "",
                        "has_overlap": bool(meta.get("has_overlap", False)),
                        "x": meta.get("x", ""),
                        "y": meta.get("y", ""),
                        "xmin": meta.get("xmin", ""),
                        "xmax": meta.get("xmax", ""),
                        "ymin": meta.get("ymin", ""),
                        "ymax": meta.get("ymax", ""),
                        "stamp_size_px": meta.get("stamp_size_px", ""),
                    }
                )
            except Exception as exc:
                failed_count += 1
                index_records.append(
                    {
                        "row_index": task.row_index,
                        "obj_id": task.obj_id,
                        "tile_index": task.tile_index,
                        "brickname": task.brickname,
                        "ra_deg": task.ra_deg,
                        "dec_deg": task.dec_deg,
                        "telescope": task.telescope,
                        "band": task.band,
                        "input_path": task.src_path,
                        "resolved_path": task.local_path,
                        "output_path": str(out_path),
                        "status": "error",
                        "message": str(exc),
                        "has_overlap": bool(meta.get("has_overlap", False)),
                        "x": meta.get("x", ""),
                        "y": meta.get("y", ""),
                        "xmin": meta.get("xmin", ""),
                        "xmax": meta.get("xmax", ""),
                        "ymin": meta.get("ymin", ""),
                        "ymax": meta.get("ymax", ""),
                        "stamp_size_px": meta.get("stamp_size_px", ""),
                    }
                )

    index_csv = output_dir / "cutout_index.csv"
    report_json = output_dir / "cutout_report.json"

    _write_index_csv(index_csv, index_records)

    report = {
        "input_csv": str(input_csv),
        "output_dir": str(output_dir),
        "size_deg": size_deg,
        "fill_value": fill_value,
        "desi_bands": desi_bands,
        "path_maps": [{"src": src, "dst": dst} for src, dst in path_maps],
        "input_rows": len(rows),
        "tasks_total": len(tasks),
        "group_count": len(grouped),
        "cutout_success": success_count,
        "cutout_failed": failed_count,
        "rejected_total": len(rejected),
        "rejected": rejected,
        "index_csv": str(index_csv),
    }
    report_json.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Batch cutout stamp generator from selection_final.csv/candidate_pool.csv"
    )
    parser.add_argument(
        "--input-csv",
        required=True,
        help="Input CSV path (recommended selection_final.csv)",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Output directory for FITS stamps and reports",
    )
    parser.add_argument(
        "--size-deg",
        type=float,
        default=0.008,
        help="Stamp size in degrees (default: 0.008)",
    )
    parser.add_argument(
        "--fill-value",
        type=float,
        default=0.0,
        help="Fill value for out-of-image pixels",
    )
    parser.add_argument(
        "--desi-bands", default="g,r,i,z", help="Comma-separated DESI bands to cut"
    )
    parser.add_argument(
        "--path-map",
        action="append",
        default=[],
        help="Path remap rule SRC=DST (repeatable)",
    )
    parser.add_argument(
        "--limit-rows", type=int, default=0, help="Only process first N rows (0 = all)"
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_csv = Path(args.input_csv).resolve()
    if not input_csv.exists():
        raise FileNotFoundError(f"Input CSV not found: {input_csv}")

    output_dir = Path(args.output_dir).resolve()
    desi_bands = [
        b.strip().lower() for b in str(args.desi_bands).split(",") if b.strip()
    ]
    path_maps = _parse_path_maps(list(args.path_map))

    report = run_cutout(
        input_csv=input_csv,
        output_dir=output_dir,
        size_deg=float(args.size_deg),
        fill_value=float(args.fill_value),
        desi_bands=desi_bands,
        path_maps=path_maps,
        limit_rows=int(args.limit_rows),
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
