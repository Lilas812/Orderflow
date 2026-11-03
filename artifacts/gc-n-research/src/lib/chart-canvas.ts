/** Preserve the backing store between draws; never reset it on pointer movement. */
export function prepareCanvas(canvas: HTMLCanvasElement, w: number, h: number, dpr: number) {
  const width = Math.max(1, Math.round(w * dpr));
  const height = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
