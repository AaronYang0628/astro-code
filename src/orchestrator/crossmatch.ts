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

const DESI_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/desi/dr10/south";
const DESI_TRACTOR_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/desi/dr10/south";

function normalizeTileId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{6,12}$/.test(trimmed) ? trimmed : null;
}

const EUCLID_MER_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/euclid/aws-mirrors/q1/MER";

function buildEuclidVisPathPattern(tileIndex: string): string {
  return `${EUCLID_MER_S3_BASE}/${tileIndex}/VIS/EUC_MER_BGSUB-MOSAIC-VIS_TILE${tileIndex}-*.fits`;
}

function buildDesiTractorIPath(brickname: string): string {
  const p = toBrickPrefix(brickname);
  return `${DESI_TRACTOR_S3_BASE}/tractor-i/${p}/tractor-i-${brickname}.fits`;
}

function buildDesiTractorPath(brickname: string): string {
  const p = toBrickPrefix(brickname);
  return `${DESI_TRACTOR_S3_BASE}/tractor/${p}/tractor-${brickname}.fits`;
}

function buildDesiImagePath(brickname: string, band: "g" | "r" | "i" | "z"): string {
  const p = toBrickPrefix(brickname);
  return `${DESI_S3_BASE}/coadd/${p}/${brickname}/legacysurvey-${brickname}-image-${band}.fits.fz`;
}

function appendMissing(base: string, missing: string[]): string {
  if (missing.length === 0) {
    return base === "none" ? "none" : base;
  }
  if (base === "none") {
    return missing.join(";");
  }
  return `${base};${missing.join(";")}`;
}

export function buildCandidatePoolFromEuclidOnly(
  euclidRows: CatalogRecord[],
  center: { ra_deg: number; dec_deg: number },
  radiusArcsec: number,
  enrichments?: {
    byObjectId?: Record<string, {
      brickname?: string | null;
      brickid?: number | null;
    }>;
  }
): CrossmatchRecord[] {
  const rows: CrossmatchRecord[] = [];

  for (let idx = 0; idx < euclidRows.length; idx += 1) {
    const e = euclidRows[idx];
    const objId = e.obj_id ?? e.object_id;
    const tileIndex = normalizeTileId(e.tile_index ?? null);
    const enrich = enrichments?.byObjectId?.[e.object_id] ?? enrichments?.byObjectId?.[objId];
    const brickname = enrich?.brickname ?? null;
    const brickid = Number.isFinite(enrich?.brickid ?? Number.NaN) ? Number(enrich?.brickid) : null;
    const euclidVisPathPattern = tileIndex ? buildEuclidVisPathPattern(tileIndex) : null;
    const desiTractorIPath = brickname ? buildDesiTractorIPath(brickname) : null;
    const desiTractorPath = brickname ? buildDesiTractorPath(brickname) : null;
    const desiImageGPath = brickname ? buildDesiImagePath(brickname, "g") : null;
    const desiImageRPath = brickname ? buildDesiImagePath(brickname, "r") : null;
    const desiImageIPath = brickname ? buildDesiImagePath(brickname, "i") : null;
    const desiImageZPath = brickname ? buildDesiImagePath(brickname, "z") : null;

    const missing: string[] = [];
    if (!tileIndex) missing.push("tile_index_missing");
    if (!brickname) missing.push("brickname_missing");
    if (!Number.isFinite(e.mag_proxy ?? Number.NaN)) missing.push("mag_proxy_missing");
    if (!Number.isFinite(e.seg_area ?? Number.NaN)) missing.push("seg_area_missing");

    rows.push({
      match_rank: idx + 1,
      center_ra: center.ra_deg,
      center_dec: center.dec_deg,
      radius_arcsec: radiusArcsec,
      dist_arcsec: 0,
      separation_arcsec: 0,
      obj_id: String(objId),
      ra: e.ra_deg,
      dec: e.dec_deg,
      type: null,
      tile_index: tileIndex,
      tile_id: tileIndex,
      brickname,
      maskbits: Number.isFinite(e.maskbits ?? Number.NaN) ? Number(e.maskbits) : null,
      mag_proxy: Number.isFinite(e.mag_proxy ?? Number.NaN) ? Number(e.mag_proxy) : null,
      seg_area: Number.isFinite(e.seg_area ?? Number.NaN) ? Number(e.seg_area) : null,
      segmentation_area: Number.isFinite(e.seg_area ?? Number.NaN) ? Number(e.seg_area) : null,
      semimajor_axis: Number.isFinite(e.semimajor_axis ?? Number.NaN) ? Number(e.semimajor_axis) : null,
      flux_segmentation: Number.isFinite(e.flux_segmentation ?? Number.NaN) ? Number(e.flux_segmentation) : null,
      RIGHT_ASCENSION: e.ra_deg,
      DECLINATION: e.dec_deg,
      SEMIMAJOR_AXIS: Number.isFinite(e.semimajor_axis ?? Number.NaN) ? Number(e.semimajor_axis) : null,
      SEGMENTATION_AREA: Number.isFinite(e.seg_area ?? Number.NaN) ? Number(e.seg_area) : null,
      FLUX_SEGMENTATION: Number.isFinite(e.flux_segmentation ?? Number.NaN) ? Number(e.flux_segmentation) : null,
      FLUX_VIS_1FWHM_APER: Number.isFinite(e.flux_vis_1fwhm_aper ?? Number.NaN) ? Number(e.flux_vis_1fwhm_aper) : null,
      FLUX_VIS_2FWHM_APER: Number.isFinite(e.flux_vis_2fwhm_aper ?? Number.NaN) ? Number(e.flux_vis_2fwhm_aper) : null,
      FLUX_VIS_3FWHM_APER: Number.isFinite(e.flux_vis_3fwhm_aper ?? Number.NaN) ? Number(e.flux_vis_3fwhm_aper) : null,
      FLUX_VIS_4FWHM_APER: Number.isFinite(e.flux_vis_4fwhm_aper ?? Number.NaN) ? Number(e.flux_vis_4fwhm_aper) : null,
      euclid_object_id: e.object_id,
      desi_object_id: null,
      euclid_ra: e.ra_deg,
      euclid_dec: e.dec_deg,
      desi_ra: null,
      desi_dec: null,
      brickid,
      ra_deg: e.ra_deg,
      dec_deg: e.dec_deg,
      euclid_mag: e.mag,
      desi_mag: null,
      class_label: e.class_label,
      source_id: e.source_id ?? null,
      target_id: null,
      tile_index_source: e.tile_index_source ?? (tileIndex ? "euclid.tile_index" : "pending_ra_dec_to_tile_mapping"),
      mag_proxy_source: Number.isFinite(e.flux_vis_1fwhm_aper ?? Number.NaN) ? "euclid.flux_vis_1fwhm_aper" : "missing",
      flux_g: null,
      flux_r: null,
      flux_i: null,
      flux_z: null,
      flux_w1: null,
      flux_w2: null,
      shape_r: null,
      shape_e1: null,
      shape_e2: null,
      sersic: null,
      ref_id: null,
      release: null,
      brick_primary: null,
      allmask_r: null,
      anymask_r: null,
      fracmasked_r: null,
      fracin_r: null,
      fracflux_r: null,
      fiberflux_r: null,
      euclid_det_quality_flag: Number.isFinite(e.det_quality_flag ?? Number.NaN) ? Number(e.det_quality_flag) : null,
      euclid_flag_vis: Number.isFinite(e.flag_vis ?? Number.NaN) ? Number(e.flag_vis) : null,
      euclid_point_like_flag: Number.isFinite(e.point_like_flag ?? Number.NaN) ? Number(e.point_like_flag) : null,
      euclid_extended_flag: Number.isFinite(e.extended_flag ?? Number.NaN) ? Number(e.extended_flag) : null,
      euclid_semimajor_axis: Number.isFinite(e.semimajor_axis ?? Number.NaN) ? Number(e.semimajor_axis) : null,
      euclid_flux_vis_1fwhm_aper: Number.isFinite(e.flux_vis_1fwhm_aper ?? Number.NaN) ? Number(e.flux_vis_1fwhm_aper) : null,
      euclid_flux_vis_2fwhm_aper: Number.isFinite(e.flux_vis_2fwhm_aper ?? Number.NaN) ? Number(e.flux_vis_2fwhm_aper) : null,
      euclid_flux_vis_3fwhm_aper: Number.isFinite(e.flux_vis_3fwhm_aper ?? Number.NaN) ? Number(e.flux_vis_3fwhm_aper) : null,
      euclid_flux_vis_4fwhm_aper: Number.isFinite(e.flux_vis_4fwhm_aper ?? Number.NaN) ? Number(e.flux_vis_4fwhm_aper) : null,
      euclid_flux_vis_psf: Number.isFinite(e.flux_vis_psf ?? Number.NaN) ? Number(e.flux_vis_psf) : null,
      euclid_flux_vis_sersic: Number.isFinite(e.flux_vis_sersic ?? Number.NaN) ? Number(e.flux_vis_sersic) : null,
      euclid_vis_path_pattern: euclidVisPathPattern,
      euclid_fits_path: euclidVisPathPattern,
      desi_tractor_fits_path: desiTractorPath,
      desi_tractor_i_fits_path: desiTractorIPath,
      desi_image_g_path: desiImageGPath,
      desi_image_r_path: desiImageRPath,
      desi_image_i_path: desiImageIPath,
      desi_image_z_path: desiImageZPath,
      path_source: "derived",
      missing_reasons: appendMissing("none", missing)
    });
  }

  return rows;
}

export function buildCandidatePoolFromDesiOnly(
  desiRows: CatalogRecord[],
  center: { ra_deg: number; dec_deg: number },
  radiusArcsec: number
): CrossmatchRecord[] {
  const rows: CrossmatchRecord[] = [];

  for (let idx = 0; idx < desiRows.length; idx += 1) {
    const d = desiRows[idx];
    const objId = d.obj_id ?? d.object_id;
    const brickname = d.brickname ?? null;
    const brickid = Number.isFinite(d.brickid ?? Number.NaN) ? Number(d.brickid) : null;

    const desiTractorIPath = brickname ? buildDesiTractorIPath(brickname) : null;
    const desiTractorPath = brickname ? buildDesiTractorPath(brickname) : null;
    const desiImageGPath = brickname ? buildDesiImagePath(brickname, "g") : null;
    const desiImageRPath = brickname ? buildDesiImagePath(brickname, "r") : null;
    const desiImageIPath = brickname ? buildDesiImagePath(brickname, "i") : null;
    const desiImageZPath = brickname ? buildDesiImagePath(brickname, "z") : null;

    const maskbits = Number.isFinite(d.maskbits ?? Number.NaN) ? Number(d.maskbits) : null;
    const magProxy = Number.isFinite(d.mag_proxy ?? Number.NaN) ? Number(d.mag_proxy) : null;
    const segArea = Number.isFinite(d.seg_area ?? Number.NaN) ? Number(d.seg_area) : null;
    const type = typeof d.type === "string" && d.type.trim().length > 0 ? d.type : null;

    const missing: string[] = [];
    if (!objId) missing.push("obj_id_missing");
    if (!brickname) missing.push("brickname_missing");
    if (maskbits === null) missing.push("maskbits_missing");
    if (magProxy === null) missing.push("mag_proxy_missing");
    if (segArea === null) missing.push("seg_area_missing");

    rows.push({
      match_rank: idx + 1,
      center_ra: center.ra_deg,
      center_dec: center.dec_deg,
      radius_arcsec: radiusArcsec,
      dist_arcsec: 0,
      separation_arcsec: 0,
      obj_id: String(objId),
      ra: d.ra_deg,
      dec: d.dec_deg,
      type,
      tile_index: null,
      tile_id: null,
      brickname,
      maskbits,
      mag_proxy: magProxy,
      seg_area: segArea,
      segmentation_area: segArea,
      semimajor_axis: null,
      flux_segmentation: null,
      RIGHT_ASCENSION: d.ra_deg,
      DECLINATION: d.dec_deg,
      SEMIMAJOR_AXIS: null,
      SEGMENTATION_AREA: segArea,
      FLUX_SEGMENTATION: null,
      FLUX_VIS_1FWHM_APER: null,
      FLUX_VIS_2FWHM_APER: null,
      FLUX_VIS_3FWHM_APER: null,
      FLUX_VIS_4FWHM_APER: null,
      euclid_object_id: "",
      desi_object_id: d.object_id,
      euclid_ra: d.ra_deg,
      euclid_dec: d.dec_deg,
      desi_ra: d.ra_deg,
      desi_dec: d.dec_deg,
      brickid,
      ra_deg: d.ra_deg,
      dec_deg: d.dec_deg,
      euclid_mag: Number.isFinite(d.mag ?? Number.NaN) ? Number(d.mag) : 99,
      desi_mag: Number.isFinite(d.mag ?? Number.NaN) ? Number(d.mag) : null,
      class_label: d.class_label,
      source_id: d.source_id ?? null,
      target_id: d.source_id ?? null,
      tile_index_source: "desi.single_catalog",
      mag_proxy_source: Number.isFinite(d.flux_r ?? Number.NaN) ? "desi.flux_r" : "desi.mag_proxy",
      flux_g: toFiniteOrNull(d.flux_g),
      flux_r: toFiniteOrNull(d.flux_r),
      flux_i: toFiniteOrNull(d.flux_i),
      flux_z: toFiniteOrNull(d.flux_z),
      flux_w1: toFiniteOrNull(d.flux_w1),
      flux_w2: toFiniteOrNull(d.flux_w2),
      shape_r: toFiniteOrNull(d.shape_r),
      shape_e1: toFiniteOrNull(d.shape_e1),
      shape_e2: toFiniteOrNull(d.shape_e2),
      sersic: toFiniteOrNull(d.sersic),
      ref_id: toFiniteOrNull(d.ref_id),
      release: toFiniteOrNull(d.release),
      brick_primary: typeof d.brick_primary === "boolean" ? d.brick_primary : null,
      allmask_r: toFiniteOrNull(d.allmask_r),
      anymask_r: toFiniteOrNull(d.anymask_r),
      fracmasked_r: toFiniteOrNull(d.fracmasked_r),
      fracin_r: toFiniteOrNull(d.fracin_r),
      fracflux_r: toFiniteOrNull(d.fracflux_r),
      fiberflux_r: toFiniteOrNull(d.fiberflux_r),
      euclid_det_quality_flag: null,
      euclid_flag_vis: null,
      euclid_point_like_flag: null,
      euclid_extended_flag: null,
      euclid_semimajor_axis: null,
      euclid_flux_vis_1fwhm_aper: null,
      euclid_flux_vis_2fwhm_aper: null,
      euclid_flux_vis_3fwhm_aper: null,
      euclid_flux_vis_4fwhm_aper: null,
      euclid_flux_vis_psf: null,
      euclid_flux_vis_sersic: null,
      euclid_vis_path_pattern: null,
      euclid_fits_path: null,
      desi_tractor_fits_path: desiTractorPath,
      desi_tractor_i_fits_path: desiTractorIPath,
      desi_image_g_path: desiImageGPath,
      desi_image_r_path: desiImageRPath,
      desi_image_i_path: desiImageIPath,
      desi_image_z_path: desiImageZPath,
      path_source: "derived",
      missing_reasons: missing.length > 0 ? missing.join(";") : "none"
    });
  }

  return rows;
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
    const tileIndex = normalizeTileId(e.tile_index ?? null);
    const brickname = best.brickname ?? null;
    const maskbits = Number.isFinite(best.maskbits ?? Number.NaN)
      ? Number(best.maskbits)
      : (Number.isFinite(e.maskbits ?? Number.NaN) ? Number(e.maskbits) : null);
    const magProxyPicked = pickMagProxy(e, best);
    const magProxy = magProxyPicked.value;
    const segArea = Number.isFinite(e.seg_area ?? Number.NaN)
      ? Number(e.seg_area)
      : (Number.isFinite(best.seg_area ?? Number.NaN) ? Number(best.seg_area) : null);
    const typeValue = best.type ?? e.type ?? best.class_label ?? e.class_label ?? "";
    const type = typeof typeValue === "string" && typeValue.trim().length > 0 ? typeValue : null;
    const brickid = Number.isFinite(best.brickid ?? Number.NaN) ? Number(best.brickid) : null;
    const tileIndexSource = e.tile_index_source ?? (tileIndex !== null ? "euclid.tile_index" : "pending_ra_dec_to_tile_mapping");
    const pathSource = "derived";

    const euclidVisPathPattern = tileIndex ? buildEuclidVisPathPattern(tileIndex) : null;
    const desiTractorIPath = brickname ? buildDesiTractorIPath(brickname) : null;
    const desiTractorPath = brickname ? buildDesiTractorPath(brickname) : null;
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
      tile_id: tileIndex,
      brickname,
      maskbits,
      mag_proxy: magProxy,
      seg_area: segArea,
      segmentation_area: segArea,
      semimajor_axis: toFiniteOrNull(e.semimajor_axis),
      flux_segmentation: toFiniteOrNull(e.flux_segmentation),
      RIGHT_ASCENSION: e.ra_deg,
      DECLINATION: e.dec_deg,
      SEMIMAJOR_AXIS: toFiniteOrNull(e.semimajor_axis),
      SEGMENTATION_AREA: segArea,
      FLUX_SEGMENTATION: toFiniteOrNull(e.flux_segmentation),
      FLUX_VIS_1FWHM_APER: toFiniteOrNull(e.flux_vis_1fwhm_aper),
      FLUX_VIS_2FWHM_APER: toFiniteOrNull(e.flux_vis_2fwhm_aper),
      FLUX_VIS_3FWHM_APER: toFiniteOrNull(e.flux_vis_3fwhm_aper),
      FLUX_VIS_4FWHM_APER: toFiniteOrNull(e.flux_vis_4fwhm_aper),
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
      euclid_fits_path: euclidVisPathPattern,
      desi_tractor_fits_path: desiTractorPath,
      desi_tractor_i_fits_path: desiTractorIPath,
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
