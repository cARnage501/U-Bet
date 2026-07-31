// Dependency-free canvas charts. No CDN, no bundler, no remote code —
// keeps the extension's CSP trivial and avoids shipping an unverified
// third-party bundle.

const COLORS = {
  axis: '#2c3b48',
  text: '#8296a7',
  line: '#2dd4bf',
  positive: '#2dd4bf',
  negative: '#f97066',
  reference: '#f59e0b',
  grid: '#1c2733',
};

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.width;
  const height = rect.height || canvas.height;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function domain(values, padFraction = 0.08) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * padFraction;
  return [min - pad, max + pad];
}

function scaler(dom, range) {
  const [d0, d1] = dom;
  const [r0, r1] = range;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

function drawFrame(ctx, width, height, padding) {
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.l, padding.t);
  ctx.lineTo(padding.l, height - padding.b);
  ctx.lineTo(width - padding.r, height - padding.b);
  ctx.stroke();
}

function drawLabel(ctx, text, x, y, align = 'left') {
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

function emptyState(ctx, width, height, message) {
  ctx.fillStyle = COLORS.text;
  ctx.font = '12px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(message, width / 2, height / 2);
}

export function renderLine(canvas, points, opts = {}) {
  const { ctx, width, height } = setupCanvas(canvas);
  if (!points.length) return emptyState(ctx, width, height, 'no data yet');

  const padding = { l: 46, r: 12, t: 12, b: 24 };
  const xDom = domain(points.map((p) => p.x), 0.02);
  const yDom = domain(points.map((p) => p.y));
  const sx = scaler(xDom, [padding.l, width - padding.r]);
  const sy = scaler(yDom, [height - padding.b, padding.t]);

  drawFrame(ctx, width, height, padding);

  if (opts.zeroLine && yDom[0] < 0 && yDom[1] > 0) {
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(padding.l, sy(0));
    ctx.lineTo(width - padding.r, sy(0));
    ctx.stroke();
  }

  ctx.strokeStyle = opts.color || COLORS.line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = sx(p.x);
    const y = sy(p.y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  drawLabel(ctx, yDom[1].toFixed(1), padding.l - 4, padding.t + 4, 'right');
  drawLabel(ctx, yDom[0].toFixed(1), padding.l - 4, height - padding.b, 'right');
  if (opts.yLabel) drawLabel(ctx, opts.yLabel, padding.l, padding.t - 2, 'left');
}

export function renderScatter(canvas, points, opts = {}) {
  const { ctx, width, height } = setupCanvas(canvas);
  if (!points.length) return emptyState(ctx, width, height, 'no data yet');

  const padding = { l: 50, r: 16, t: 12, b: 28 };
  const xDom = domain(points.map((p) => p.x));
  const yDom = domain(points.map((p) => p.y));
  const sx = scaler(xDom, [padding.l, width - padding.r]);
  const sy = scaler(yDom, [height - padding.b, padding.t]);

  drawFrame(ctx, width, height, padding);

  if (opts.referenceX != null && opts.referenceX >= xDom[0] && opts.referenceX <= xDom[1]) {
    ctx.strokeStyle = COLORS.reference;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(sx(opts.referenceX), padding.t);
    ctx.lineTo(sx(opts.referenceX), height - padding.b);
    ctx.stroke();
    ctx.setLineDash([]);
    if (opts.referenceLabel) drawLabel(ctx, opts.referenceLabel, sx(opts.referenceX), padding.t + 10, 'center');
  }

  ctx.fillStyle = opts.color || COLORS.line;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(sx(p.x), sy(p.y), 2.5, 0, Math.PI * 2);
    ctx.globalAlpha = 0.65;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawLabel(ctx, xDom[0].toFixed(0), padding.l, height - padding.b + 12, 'left');
  drawLabel(ctx, xDom[1].toFixed(0), width - padding.r, height - padding.b + 12, 'right');
  if (opts.xLabel) drawLabel(ctx, opts.xLabel, width - padding.r, height - 4, 'right');
  if (opts.yLabel) drawLabel(ctx, opts.yLabel, padding.l, padding.t - 2, 'left');
}

export function renderBar(canvas, categories, opts = {}) {
  const { ctx, width, height } = setupCanvas(canvas);
  if (!categories.length) return emptyState(ctx, width, height, 'no data yet');

  const padding = { l: 46, r: 12, t: 12, b: 32 };
  const values = categories.map((c) => c.value);
  const yDom = [Math.min(0, ...values), Math.max(0, ...values) || 1];
  const sy = scaler(yDom, [height - padding.b, padding.t]);
  const bandWidth = (width - padding.l - padding.r) / categories.length;

  drawFrame(ctx, width, height, padding);

  categories.forEach((c, i) => {
    const x = padding.l + i * bandWidth + bandWidth * 0.15;
    const barWidth = bandWidth * 0.7;
    const y0 = sy(0);
    const y1 = sy(c.value);
    ctx.fillStyle = c.value >= 0 ? COLORS.positive : COLORS.negative;
    ctx.fillRect(x, Math.min(y0, y1), barWidth, Math.abs(y1 - y0) || 1);
    drawLabel(ctx, c.label, x + barWidth / 2, height - padding.b + 12, 'center');
  });

  drawLabel(ctx, yDom[1].toFixed(1), padding.l - 4, padding.t + 4, 'right');
}
