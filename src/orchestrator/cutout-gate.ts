export function resolveCutoutEnabled(
  requestedEnabled: boolean | undefined,
  isEuclidSingleWorkflow: boolean
): boolean {
  return requestedEnabled ?? isEuclidSingleWorkflow;
}

export function shouldExecuteCutout(
  cutoutEnabled: boolean,
  selectionFinalRows: number
): boolean {
  return cutoutEnabled && selectionFinalRows > 0;
}
