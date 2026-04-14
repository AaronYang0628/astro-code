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

function toFiniteOrNull(value: number | undefined): number | null {
  return Number.isFinite(value ?? Number.NaN) ? Number(value) : null;
}

function pickMagProxy(e: CatalogRecord, d: CatalogRecord): { value: number | null; source: string } {
  if (Number.isFinite(d.flux_r ?? Number.NaN)) {
    return {
      value: Number.isFinite(d.mag_proxy ?? Number.NaN) ? Number(d.mag_proxy) : (Number.isFinite(d.mag) ? Number(d.mag) : null),
      source: "desi.flux_r"
    };
  }
  if (Number.isFinite(d.mag_proxy ?? Number.NaN)) {
    return { value: Number(d.mag_proxy), source: "desi.mag_proxy" };
  }
  if (Number.isFinite(e.flux_vis_1fwhm_aper ?? Number.NaN)) {
    return { value: Number(e.mag_proxy), source: "euclid.flux_vis_1fwhm_aper" };
  }
  if (Number.isFinite(e.mag_proxy ?? Number.NaN)) {
    return { value: Number(e.mag_proxy), source: "euclid.mag_proxy" };
  }
  return { value: null, source: "missing" };
}

function toBrickPrefix(brickname: string): string {
  return brickname.slice(0, 3);
}

function buildEuclidVisPathPattern(tileIndex: string): string {
  return `https://irsa.ipac.caltech.edu/ibe/data/euclid/q1/MER/${tileIndex}/VIS/EUC_MER_BGSUB-MOSAIC-VIS_TILE${tileIndex}-*.fits`;
}

function buildDesiTractorIPath(brickname: string): string {
  const p = toBrickPrefix(brickname);
  return `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/tractor-i/${p}/tractor-i-${brickname}.fits`;
}

function buildDesiImagePath(brickname: string, band: "g" | "r" | "i" | "z"): string {
  const p = toBrickPrefix(brickname);
  return `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/coadd/${p}/${brickname}/legacysurvey-${brickname}-image-${band}.fits.fz`;
}

export function crossmatchCatalogs(
  euclidRows: CatalogRecord[],
  desiRows: CatalogRecord[],
  radiusArcsec: number,
  center?: { ra_deg: number; dec_deg: number }
): CrossmatchRecord[] {
  const results: CrossmatchRecord[] = [];
  let rank = 0;

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

    rank += 1;
    const distArcsec = Number(bestSep.toFixed(6));

    const objId = best.obj_id ?? best.object_id ?? e.obj_id ?? e.object_id;
    const tileIndex = e.tile_index ?? null;
    const brickname = best.brickname ?? null;
    const maskbits = Number.isFinite(best.maskbits ?? Number.NaN)
      ? Number(best.maskbits)
      : (Number.isFinite(e.maskbits ?? Number.NaN) ? Number(e.maskbits) : null);
    const magProxyPicked = pickMagProxy(e, best);
    const magProxy = magProxyPicked.value;
    const segArea = Number.isFinite(e.seg_area ?? Number.NaN)
      ? Number(e.seg_area)
      : (Number.isFinite(best.seg_area ?? Number.NaN) ? Number(best.seg_area) : null);
    const type = best.type ?? e.type ?? best.class_label ?? e.class_label ?? "unknown";
    const brickid = Number.isFinite(best.brickid ?? Number.NaN) ? Number(best.brickid) : null;
    const tileIndexSource = e.tile_index_source ?? (tileIndex !== null ? "euclid.tile_index" : "pending_ra_dec_to_tile_mapping");
    const pathSource = String(best.source_system ?? "").toLowerCase().startsWith("mock")
      ? "mock"
      : "derived";

    const euclidVisPathPattern = tileIndex ? buildEuclidVisPathPattern(tileIndex) : null;
    const desiTractorIPath = brickname ? buildDesiTractorIPath(brickname) : null;
    const desiImageGPath = brickname ? buildDesiImagePath(brickname, "g") : null;
    const desiImageRPath = brickname ? buildDesiImagePath(brickname, "r") : null;
    const desiImageIPath = brickname ? buildDesiImagePath(brickname, "i") : null;
    const desiImageZPath = brickname ? buildDesiImagePath(brickname, "z") : null;

    const missingReasons: string[] = [];
    if (!objId) missingReasons.push("obj_id_missing");
    if (tileIndex === null) missingReasons.push("tile_index_missing");
    if (brickname === null) missingReasons.push("brickname_missing");
    if (maskbits === null) missingReasons.push("maskbits_missing");
    if (magProxy === null) missingReasons.push("mag_proxy_missing");
    if (segArea === null) missingReasons.push("seg_area_missing");

    results.push({
      match_rank: rank,
      center_ra: center?.ra_deg ?? e.ra_deg,
      center_dec: center?.dec_deg ?? e.dec_deg,
      radius_arcsec: radiusArcsec,
      dist_arcsec: distArcsec,
      separation_arcsec: distArcsec,
      obj_id: String(objId),
      ra: best.ra_deg,
      dec: best.dec_deg,
      type,
      tile_index: tileIndex,
      brickname,
      maskbits,
      mag_proxy: magProxy,
      seg_area: segArea,
      euclid_object_id: e.object_id,
      desi_object_id: best.object_id,
      euclid_ra: e.ra_deg,
      euclid_dec: e.dec_deg,
      desi_ra: best.ra_deg,
      desi_dec: best.dec_deg,
      brickid,
      ra_deg: e.ra_deg,
      dec_deg: e.dec_deg,
      euclid_mag: e.mag,
      desi_mag: best.mag,
      class_label: e.class_label,
      source_id: e.source_id ?? null,
      target_id: best.source_id ?? null,
      tile_index_source: tileIndexSource,
      mag_proxy_source: magProxyPicked.source,
      flux_g: toFiniteOrNull(best.flux_g),
      flux_r: toFiniteOrNull(best.flux_r),
      flux_i: toFiniteOrNull(best.flux_i),
      flux_z: toFiniteOrNull(best.flux_z),
      flux_w1: toFiniteOrNull(best.flux_w1),
      flux_w2: toFiniteOrNull(best.flux_w2),
      shape_r: toFiniteOrNull(best.shape_r),
      shape_e1: toFiniteOrNull(best.shape_e1),
      shape_e2: toFiniteOrNull(best.shape_e2),
      sersic: toFiniteOrNull(best.sersic),
      ref_id: toFiniteOrNull(best.ref_id),
      release: toFiniteOrNull(best.release),
      brick_primary: typeof best.brick_primary === "boolean" ? best.brick_primary : null,
      allmask_r: toFiniteOrNull(best.allmask_r),
      anymask_r: toFiniteOrNull(best.anymask_r),
      fracmasked_r: toFiniteOrNull(best.fracmasked_r),
      fracin_r: toFiniteOrNull(best.fracin_r),
      fracflux_r: toFiniteOrNull(best.fracflux_r),
      fiberflux_r: toFiniteOrNull(best.fiberflux_r),
      euclid_det_quality_flag: toFiniteOrNull(e.det_quality_flag),
      euclid_flag_vis: toFiniteOrNull(e.flag_vis),
      euclid_point_like_flag: toFiniteOrNull(e.point_like_flag),
      euclid_extended_flag: toFiniteOrNull(e.extended_flag),
      euclid_semimajor_axis: toFiniteOrNull(e.semimajor_axis),
      euclid_flux_vis_1fwhm_aper: toFiniteOrNull(e.flux_vis_1fwhm_aper),
      euclid_flux_vis_2fwhm_aper: toFiniteOrNull(e.flux_vis_2fwhm_aper),
      euclid_flux_vis_3fwhm_aper: toFiniteOrNull(e.flux_vis_3fwhm_aper),
      euclid_flux_vis_4fwhm_aper: toFiniteOrNull(e.flux_vis_4fwhm_aper),
      euclid_flux_vis_psf: toFiniteOrNull(e.flux_vis_psf),
      euclid_flux_vis_sersic: toFiniteOrNull(e.flux_vis_sersic),
      euclid_vis_path_pattern: euclidVisPathPattern,
      desi_tractor_i_path: desiTractorIPath,
      desi_image_g_path: desiImageGPath,
      desi_image_r_path: desiImageRPath,
      desi_image_i_path: desiImageIPath,
      desi_image_z_path: desiImageZPath,
      path_source: pathSource,
      missing_reasons: missingReasons.length > 0 ? missingReasons.join(";") : "none"
    });
  }

  return results;
}
