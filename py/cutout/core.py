#!/usr/bin/env python3

from __future__ import annotations

from typing import Iterable

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales


def _normalize_device(device: str) -> str:
    normalized = str(device or "").strip().lower()
    return "euclid" if normalized == "euclid" else "desi"


def _select_hdu(hdul: fits.HDUList, device: str):
    wanted = 0 if _normalize_device(device) == "euclid" else 1
    if wanted < len(hdul) and getattr(hdul[wanted], "data", None) is not None:
        return hdul[wanted]

    for hdu in hdul:
        if getattr(hdu, "data", None) is not None:
            return hdu

    raise ValueError(f"No image HDU with data found for device={device}")


def _as_2d(data: np.ndarray) -> np.ndarray:
    arr = np.asarray(data)
    if arr.ndim == 2:
        return arr
    if arr.ndim < 2:
        raise ValueError("FITS image data is not at least 2D")
    while arr.ndim > 2:
        arr = arr[0]
    return arr


def _pixel_scale_deg(header: fits.Header, wcs: WCS) -> float:
    cd1_1 = header.get("CD1_1")
    if cd1_1 is not None:
        try:
            value = abs(float(cd1_1))
            if value > 0:
                return value
        except Exception:
            pass

    cdelt1 = header.get("CDELT1")
    if cdelt1 is not None:
        try:
            value = abs(float(cdelt1))
            if value > 0:
                return value
        except Exception:
            pass

    try:
        scales = proj_plane_pixel_scales(wcs)
        if len(scales) >= 2:
            sx = abs(float(scales[0]))
            sy = abs(float(scales[1]))
            s = min(v for v in (sx, sy) if v > 0)
            if s > 0:
                return s
    except Exception:
        pass

    return 1.0 / 3600.0


def _cutout_from_hdu(
    hdu,
    wcs: WCS,
    ra_deg: float,
    dec_deg: float,
    size_deg: float,
    fill_value: float,
):
    image_2d = _as_2d(hdu.data)
    x, y = wcs.world_to_pixel_values(ra_deg, dec_deg)[:2]

    scale = _pixel_scale_deg(hdu.header, wcs)
    half_size_px = max(1, int(size_deg / scale / 2.0))
    stamp_px = half_size_px * 2

    xmin = max(0, int(x) - half_size_px)
    xmax = min(image_2d.shape[-1], int(x) + half_size_px)
    ymin = max(0, int(y) - half_size_px)
    ymax = min(image_2d.shape[-2], int(y) + half_size_px)

    out = np.full((stamp_px, stamp_px), fill_value, dtype=image_2d.dtype)
    actual_h = max(0, ymax - ymin)
    actual_w = max(0, xmax - xmin)
    has_overlap = actual_h > 0 and actual_w > 0

    if has_overlap:
        out[:actual_h, :actual_w] = image_2d[ymin:ymax, xmin:xmax]

    header = hdu.header.copy()
    if "CRPIX1" in header:
        header["CRPIX1"] = float(header["CRPIX1"]) - xmin
    if "CRPIX2" in header:
        header["CRPIX2"] = float(header["CRPIX2"]) - ymin

    cutout_hdul = fits.HDUList([fits.PrimaryHDU(data=out, header=header)])
    meta = {
        "x": float(x),
        "y": float(y),
        "xmin": int(xmin),
        "xmax": int(xmax),
        "ymin": int(ymin),
        "ymax": int(ymax),
        "stamp_size_px": int(stamp_px),
        "has_overlap": bool(has_overlap),
    }
    return cutout_hdul, meta


def cutout_image(
    ra_deg: float,
    dec_deg: float,
    filename: str,
    size_deg: float = 0.008,
    device: str = "Euclid",
    fill_value: float = 0.0,
):
    with fits.open(filename, memmap=True) as hdul:
        hdu = _select_hdu(hdul, device)
        wcs = WCS(hdu.header)
        cutout, _meta = _cutout_from_hdu(
            hdu, wcs, ra_deg, dec_deg, size_deg, fill_value
        )
        return cutout


def cutout_image_objlist(
    ra_list: Iterable[float],
    dec_list: Iterable[float],
    filename: str,
    size_deg: float = 0.008,
    device: str = "Euclid",
    fill_value: float = 0.0,
    return_meta: bool = False,
):
    ra_values = list(ra_list)
    dec_values = list(dec_list)
    if len(ra_values) != len(dec_values):
        raise ValueError("ra_list and dec_list must have the same length")

    cutouts = []
    metas = []
    with fits.open(filename, memmap=True) as hdul:
        hdu = _select_hdu(hdul, device)
        wcs = WCS(hdu.header)
        for ra_deg, dec_deg in zip(ra_values, dec_values):
            cutout, meta = _cutout_from_hdu(
                hdu,
                wcs,
                float(ra_deg),
                float(dec_deg),
                float(size_deg),
                float(fill_value),
            )
            cutouts.append(cutout)
            metas.append(meta)

    if return_meta:
        return cutouts, metas
    return cutouts
