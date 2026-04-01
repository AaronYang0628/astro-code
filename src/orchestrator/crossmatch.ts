import type { CatalogRecord, CrossmatchRecord } from "./types.js";

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function angularDistanceArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const ra1r = toRadians(ra1);
  const dec1r = toRadians(dec1);
  const ra2r = toRadians(ra2);
  const dec2r = toRadians(dec2);

  const sinDDec = Math.sin((dec2r - dec1r) / 2);
  const sinDRa = Math.sin((ra2r - ra1r) / 2);
  const a = sinDDec * sinDDec + Math.cos(dec1r) * Math.cos(dec2r) * sinDRa * sinDRa;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return c * 206264.806;
}

export function crossmatchCatalogs(
  euclidRows: CatalogRecord[],
  desiRows: CatalogRecord[],
  radiusArcsec: number
): CrossmatchRecord[] {
  const results: CrossmatchRecord[] = [];

  for (const e of euclidRows) {
    let best: CatalogRecord | null = null;
    let bestSep = Number.POSITIVE_INFINITY;

    for (const d of desiRows) {
      const sep = angularDistanceArcsec(e.ra_deg, e.dec_deg, d.ra_deg, d.dec_deg);
      if (sep <= radiusArcsec && sep < bestSep) {
        best = d;
        bestSep = sep;
      }
    }

    if (!best) {
      continue;
    }

    results.push({
      euclid_object_id: e.object_id,
      desi_object_id: best.object_id,
      ra_deg: e.ra_deg,
      dec_deg: e.dec_deg,
      euclid_mag: e.mag,
      desi_mag: best.mag,
      separation_arcsec: Number(bestSep.toFixed(4)),
      class_label: e.class_label
    });
  }

  return results;
}
