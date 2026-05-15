#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from astropy.io import fits
from astropy.wcs import WCS

from cutout.core import _cutout_from_hdu, _select_hdu


def _safe_token(value: str | None, default: str) -> str:
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)


def _open_fits(path: str) -> fits.HDUList:
    open_kwargs: dict[str, Any] = {"memmap": True}
    if path.startswith("s3://"):
        open_kwargs["use_fsspec"] = True
    return fits.open(path, **open_kwargs)


def _resolve_source_uri(source_uri: str, resolve_wildcard: bool) -> str:
    if "*" in source_uri and not resolve_wildcard:
        raise ValueError("source_uri contains wildcard but resolve_wildcard=false")
    return source_uri


def _target_to_output_path(
    output_root: str,
    run_id: str,
    telescope: str,
    band: str,
    row_index: int,
    obj_id: str,
    tile_index: str | None,
    brickname: str | None,
) -> str:
    out_dir = Path(output_root) / run_id / telescope / band
    out_dir.mkdir(parents=True, exist_ok=True)
    name = (
        f"row{row_index:06d}"
        f"_obj_{_safe_token(obj_id, 'obj_na')}"
        f"_tile_{_safe_token(tile_index, 'tile_na')}"
        f"_brick_{_safe_token(brickname, 'brick_na')}"
        f"_{telescope}_{band}.fits"
    )
    return str((out_dir / name).resolve())


def execute_cutout_group(payload: dict[str, Any]) -> dict[str, Any]:
    run_id = str(payload.get("run_id") or "run_na")
    telescope = str(payload.get("telescope") or "euclid").strip().lower()
    band = str(payload.get("band") or "vis").strip().lower()
    source_uri = str(payload.get("source_uri") or "").strip()
    size_deg = float(payload.get("size_deg") or 0.008)
    output_prefix = str(payload.get("output_prefix") or "./runs").strip()
    resolve_wildcard = bool(payload.get("resolve_wildcard", True))
    targets_raw = payload.get("targets")

    if not source_uri:
        return {"error": "missing source_uri", "results": []}
    if not isinstance(targets_raw, list) or len(targets_raw) == 0:
        return {"error": "missing targets", "results": []}

    try:
        resolved_source_uri = _resolve_source_uri(source_uri, resolve_wildcard)
    except Exception as exc:
        return {"error": str(exc), "results": []}

    results: list[dict[str, Any]] = []
    try:
        with _open_fits(resolved_source_uri) as hdul:
            hdu = _select_hdu(hdul, "Euclid" if telescope == "euclid" else "DESI")
            wcs = WCS(hdu.header)

            for target in targets_raw:
                obj_id = str(target.get("obj_id") or "")
                row_index = int(target.get("row_index"))
                ra_deg = float(target.get("ra_deg"))
                dec_deg = float(target.get("dec_deg"))
                tile_index = (
                    str(target.get("tile_index")) if target.get("tile_index") is not None else None
                )
                brickname = (
                    str(target.get("brickname")) if target.get("brickname") is not None else None
                )

                try:
                    cutout_hdul, meta = _cutout_from_hdu(
                        hdu=hdu,
                        wcs=wcs,
                        ra_deg=ra_deg,
                        dec_deg=dec_deg,
                        size_deg=size_deg,
                        fill_value=0.0,
                    )
                    out_path = _target_to_output_path(
                        output_root=output_prefix,
                        run_id=run_id,
                        telescope=telescope,
                        band=band,
                        row_index=row_index,
                        obj_id=obj_id,
                        tile_index=tile_index,
                        brickname=brickname,
                    )
                    cutout_hdul.writeto(out_path, overwrite=True)
                    results.append(
                        {
                            "status": "ok",
                            "row_index": row_index,
                            "obj_id": obj_id,
                            "ra_deg": ra_deg,
                            "dec_deg": dec_deg,
                            "output_uri": out_path,
                            "meta": meta,
                        }
                    )
                except Exception as exc:
                    results.append(
                        {
                            "status": "error",
                            "row_index": row_index,
                            "obj_id": obj_id,
                            "ra_deg": ra_deg,
                            "dec_deg": dec_deg,
                            "error": str(exc),
                        }
                    )
    except Exception as exc:
        return {
            "resolved_source_uri": resolved_source_uri,
            "error": str(exc),
            "results": [],
        }

    return {
        "resolved_source_uri": resolved_source_uri,
        "results": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="fits-cutout local service (stdio JSON)")
    parser.add_argument(
        "--tool",
        default="execute_cutout_group",
        help="tool name, only execute_cutout_group supported",
    )
    parser.add_argument(
        "--input-json",
        required=True,
        help="path to input JSON payload",
    )
    args = parser.parse_args()

    if args.tool != "execute_cutout_group":
        raise ValueError(f"unsupported tool: {args.tool}")

    payload = json.loads(Path(args.input_json).read_text(encoding="utf-8"))
    if "output_prefix" not in payload or not str(payload.get("output_prefix") or "").strip():
        payload["output_prefix"] = os.environ.get("FITS_CUTOUT_OUTPUT_PREFIX", "./runs")

    result = execute_cutout_group(payload)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
