#!/usr/bin/env python3
# pyright: reportMissingImports=false

import argparse
import csv
import json
from pathlib import Path


RA_KEYS = ["ra", "ra_deg", "raj2000", "alpha", "objra", "crval1"]
DEC_KEYS = ["dec", "dec_deg", "dej2000", "delta", "objdec", "crval2"]


def _as_float(value):
    if value is None:
        return None
    try:
        return float(str(value).strip())
    except Exception:
        return None


def _find_key(candidates, keys):
    lowered = {str(k).lower(): k for k in candidates}
    for key in keys:
        if key in lowered:
            return lowered[key]
    return None


def extract_from_csv(file_path: Path):
    with file_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        first = next(reader, None)
        if not first:
            raise ValueError("CSV has no data rows")

        ra_key = _find_key(first.keys(), RA_KEYS)
        dec_key = _find_key(first.keys(), DEC_KEYS)
        if not ra_key or not dec_key:
            raise ValueError("CSV missing RA/DEC columns")

        ra = _as_float(first.get(ra_key))
        dec = _as_float(first.get(dec_key))
        if ra is None or dec is None:
            raise ValueError("CSV RA/DEC are not numeric")

        return {
            "ra_deg": ra,
            "dec_deg": dec,
            "source": "python_csv"
        }


def extract_from_fits(file_path: Path):
    try:
        from astropy.io import fits
    except Exception as exc:
        raise RuntimeError("astropy is required for FITS parsing") from exc

    with fits.open(file_path) as hdul:
        header = hdul[0].header
        ra = None
        dec = None

        for key in RA_KEYS:
            if key.upper() in header:
                ra = _as_float(header.get(key.upper()))
                if ra is not None:
                    break

        for key in DEC_KEYS:
            if key.upper() in header:
                dec = _as_float(header.get(key.upper()))
                if dec is not None:
                    break

        if ra is None or dec is None:
            raise ValueError("FITS header missing numeric RA/DEC")

        return {
            "ra_deg": ra,
            "dec_deg": dec,
            "source": "python_fits_header"
        }


def main():
    parser = argparse.ArgumentParser(description="Extract RA/DEC from CSV or FITS")
    parser.add_argument("--file", required=True, help="Input file path")
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        raise FileNotFoundError(f"Input file not found: {file_path}")

    ext = file_path.suffix.lower()
    if ext == ".csv":
        result = extract_from_csv(file_path)
    elif ext in {".fits", ".fit", ".fts"}:
        result = extract_from_fits(file_path)
    else:
        raise ValueError(f"Unsupported file extension: {ext}")

    print(json.dumps(result))


if __name__ == "__main__":
    main()
