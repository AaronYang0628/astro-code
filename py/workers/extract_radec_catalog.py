#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path


RA_KEYS = [
    "RA",
    "ra",
    "ra_deg",
    "RIGHT_ASCENSION",
    "right_ascension",
]

DEC_KEYS = [
    "DEC",
    "dec",
    "dec_deg",
    "DECLINATION",
    "declination",
]


def _to_float(value):
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def _pick_column(table, keys):
    names = {str(name).strip().lower(): str(name) for name in table.colnames}
    for key in keys:
        wanted = key.lower()
        if wanted in names:
            return names[wanted]
    return None


def _extract_stats_from_table(table):
    ra_col = _pick_column(table, RA_KEYS)
    dec_col = _pick_column(table, DEC_KEYS)
    if not ra_col or not dec_col:
        raise ValueError("FITS table missing RA/DEC columns")

    ra_values = []
    dec_values = []
    for ra_raw, dec_raw in zip(table[ra_col], table[dec_col]):
        ra = _to_float(ra_raw)
        dec = _to_float(dec_raw)
        if ra is None or dec is None:
            continue
        ra_values.append(ra)
        dec_values.append(dec)

    if not ra_values or not dec_values:
        raise ValueError("FITS table RA/DEC columns have no numeric rows")

    ra_min = min(ra_values)
    ra_max = max(ra_values)
    dec_min = min(dec_values)
    dec_max = max(dec_values)
    return {
        "ra_deg": (ra_min + ra_max) / 2.0,
        "dec_deg": (dec_min + dec_max) / 2.0,
        "ra_min": ra_min,
        "ra_max": ra_max,
        "dec_min": dec_min,
        "dec_max": dec_max,
        "num_objects": len(ra_values),
        "source": "python_fits_table",
    }


def extract_from_fits(input_path: str):
    try:
        from astropy.io import fits
        from astropy.table import Table
    except Exception as exc:
        raise RuntimeError("astropy is required for FITS parsing") from exc

    open_kwargs = {}
    if input_path.startswith("s3://"):
        try:
            import fsspec  # noqa: F401
        except Exception as exc:
            raise RuntimeError(
                "fsspec is required for S3 FITS fallback parsing; please install fsspec"
            ) from exc
        open_kwargs = {"use_fsspec": True}

    with fits.open(input_path, memmap=True, **open_kwargs) as hdul:
        for hdu in hdul:
            data = getattr(hdu, "data", None)
            if data is None:
                continue
            try:
                table = Table(data)
            except Exception:
                continue
            if len(getattr(table, "colnames", [])) == 0:
                continue
            try:
                return _extract_stats_from_table(table)
            except Exception:
                continue

    raise ValueError("No FITS table HDU with usable RA/DEC columns found")


def main():
    parser = argparse.ArgumentParser(
        description="Extract RA/DEC center/range from FITS catalog"
    )
    parser.add_argument("--input", required=True, help="FITS path (local or s3://)")
    args = parser.parse_args()

    value = args.input
    if not value.startswith("s3://"):
        file_path = Path(value)
        if not file_path.exists():
            raise FileNotFoundError(f"Input not found: {value}")

    result = extract_from_fits(value)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
