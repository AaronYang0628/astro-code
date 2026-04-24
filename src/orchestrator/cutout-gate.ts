export function resolveCutoutEnabled(
  requestedEnabled: boolean | undefined,
  isSingleCatalogWorkflow: boolean
): boolean {
  return requestedEnabled ?? isSingleCatalogWorkflow;
}

export function shouldExecuteCutout(
  cutoutEnabled: boolean,
  selectionFinalRows: number
): boolean {
  return cutoutEnabled && selectionFinalRows > 0;
}
