export function getVisibleViewportBounds(targetWindow) {
  const viewport = targetWindow?.visualViewport;
  const left = Number(viewport?.offsetLeft) || 0;
  const top = Number(viewport?.offsetTop) || 0;
  const width = Number(viewport?.width) || Number(targetWindow?.innerWidth) || 0;
  const height = Number(viewport?.height) || Number(targetWindow?.innerHeight) || 0;
  return { left, top, width, height };
}

export function clampFloatingPosition(position, size, viewport, margin = 4) {
  const minX = viewport.left + margin;
  const minY = viewport.top + margin;
  const maxX = Math.max(minX, viewport.left + viewport.width - size.width - margin);
  const maxY = Math.max(minY, viewport.top + viewport.height - size.height - margin);
  return {
    x: Math.min(Math.max(minX, Number(position?.x) || 0), maxX),
    y: Math.min(Math.max(minY, Number(position?.y) || 0), maxY)
  };
}

export function getDefaultMinimizedPosition(size, viewport, margin = 4, bottomGap = 24) {
  return clampFloatingPosition({
    x: viewport.left + (viewport.width - size.width) / 2,
    y: viewport.top + viewport.height - size.height - bottomGap
  }, size, viewport, margin);
}
