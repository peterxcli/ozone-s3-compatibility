export interface GraphViewportFitInput {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
  minZoom: number;
  maxZoom: number;
  padding?: number;
}

export interface GraphViewportFit {
  zoom: number;
  pan: {
    x: number;
    y: number;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positiveFiniteOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function fitContentToViewport(input: GraphViewportFitInput): GraphViewportFit {
  const viewportWidth = positiveFiniteOr(input.viewportWidth, 1);
  const viewportHeight = positiveFiniteOr(input.viewportHeight, 1);
  const contentWidth = positiveFiniteOr(input.contentWidth, 1);
  const contentHeight = positiveFiniteOr(input.contentHeight, 1);
  const padding = Math.max(0, input.padding ?? 0);
  const minZoom = Math.min(input.minZoom, input.maxZoom);
  const maxZoom = Math.max(input.minZoom, input.maxZoom);
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const zoom = clamp(Math.min(availableWidth / contentWidth, availableHeight / contentHeight), minZoom, maxZoom);

  return {
    zoom,
    pan: {
      x: padding + (availableWidth - contentWidth * zoom) / 2,
      y: padding + (availableHeight - contentHeight * zoom) / 2,
    },
  };
}
