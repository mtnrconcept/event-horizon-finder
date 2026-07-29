export type MapSurfaceSize = {
  width: number;
  height: number;
};

const MIN_RENDERABLE_MAP_EDGE_PX = 2;

export function readMapSurfaceSize(
  element: Pick<HTMLElement, "clientWidth" | "clientHeight">,
): MapSurfaceSize {
  return {
    width: element.clientWidth,
    height: element.clientHeight,
  };
}

export function isRenderableMapSurfaceSize(size: MapSurfaceSize): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width >= MIN_RENDERABLE_MAP_EDGE_PX &&
    size.height >= MIN_RENDERABLE_MAP_EDGE_PX
  );
}

export function mapSurfaceSizesMatch(
  container: MapSurfaceSize,
  canvas: MapSurfaceSize,
  tolerancePx = 1,
): boolean {
  if (!isRenderableMapSurfaceSize(container) || !isRenderableMapSurfaceSize(canvas)) return false;
  const tolerance = Number.isFinite(tolerancePx) ? Math.max(0, tolerancePx) : 0;
  return (
    Math.abs(container.width - canvas.width) <= tolerance &&
    Math.abs(container.height - canvas.height) <= tolerance
  );
}
