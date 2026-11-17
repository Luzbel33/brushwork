(function startPaintingWorker() {
  'use strict';
  // The planner stays in a worker even when the browser only offers Canvas 2D on the main thread.
  function createSurface({w, h, outputWidth, outputHeight, ground}, onPage, stopped = () => false) {
    function canvas(width, height) {
      if (!onPage) return new OffscreenCanvas(width, height);
      const element = document.createElement('canvas');
      element.width = width;
      element.height = height;
      return element;
    }
    const master = canvas(outputWidth, outputHeight);
    const probe = canvas(w, h);
    if (!onPage && typeof master.convertToBlob !== 'function') throw new Error('Worker PNG export is unavailable');
    const options = {alpha: false, willReadFrequently: true};
    const surface = master.getContext('2d', options);
    const read = probe.getContext('2d', options);
    if (!surface || !read) throw new Error('Canvas 2D is unavailable');
    surface.fillStyle = ground;
    surface.fillRect(0, 0, outputWidth, outputHeight);
    surface.scale(outputWidth / w, outputHeight / h);
    function png() {
      if (!onPage) return master.convertToBlob({type: 'image/png'});
      return new Promise((resolve, reject) => master.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('PNG export failed'));
      }, 'image/png'));
    }

    return async ({op, buffer, count, snapshot}) => {
      if (op === 'sample') {
        read.drawImage(master, 0, 0, w, h);
        return {pixels: read.getImageData(0, 0, w, h).data.buffer};
      }
      if (op === 'finish') return {png: await png()};
      const checkpoint = snapshot ? await png() : undefined;
      const view = new DataView(buffer);
      if (stopped()) return {};
      let deadline = performance.now() + 7;
      for (let index = 0; index < count; index++) {
        Pincel.mark(surface, view, index);
        if (onPage && (index + 1) % 64 === 0 && performance.now() >= deadline) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (stopped()) return {};
          deadline = performance.now() + 7;
        }
      }
      return {buffer, checkpoint};
    };
  }

  if (typeof document !== 'undefined') {
    let workerUrl;
    window.createPaintingWorker = () => {
      if (!workerUrl) {
        const source = ['(', window.installStudioBrush.toString(), ')(self);\n(', startPaintingWorker
          .toString(), ')();'
        ];
        workerUrl = URL.createObjectURL(new Blob(source, {
          type: 'text/javascript'
        }));
      }
      const worker = new Worker(workerUrl);
      let surface, stopped = false;
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        stopped = true;
        surface = null;
        terminate();
      };
      worker.addEventListener('message', async ({data}) => {
        if (data.type !== 'surface' || stopped) return;
        try {
          if (data.op === 'init') surface = createSurface(data, true, () => stopped);
          const result = data.op === 'init' ? {} : await surface(data);
          const transfer = result.buffer || result.pixels;
          if (!stopped) worker.postMessage({type: 'surfaceResult', ...result}, transfer ? [transfer] : []);
        } catch {
          if (!stopped) worker.postMessage({type: 'surfaceResult', error: true});
        }
      });
      return worker;
    };
    return;
  }
  // Both the live session and the downloadable file use the same physical brush.
  if (!self.Pincel) importScripts('brush.js');
  const passes = [
    // pitch, smoothing radius, stroke length, width, tolerated color change, remaining error
    {
      pitch: 53,
      blur: 17,
      length: 199,
      width: 139,
      tolerance: 70,
      error: 0,
      opacity: .98,
      noise: 3.0,
      seconds: 12
    },
    {
      pitch: 26,
      blur: 8,
      length: 104,
      width: 67,
      tolerance: 42,
      error: 0,
      opacity: .96,
      noise: 2.7,
      seconds: 15
    },
    {
      pitch: 13,
      blur: 4,
      length: 56,
      width: 31,
      tolerance: 26,
      error: 2.5,
      opacity: .96,
      noise: 2.1,
      seconds: 17
    },
    {
      pitch: 7,
      blur: 2,
      length: 32,
      width: 15,
      tolerance: 18,
      error: 2.1,
      opacity: .94,
      noise: 1.4,
      seconds: 18
    },
    {
      pitch: 4.5,
      blur: 1,
      length: 23,
      width: 9.5,
      tolerance: 11,
      error: 2.0,
      opacity: .91,
      noise: 1.0,
      seconds: 17
    },
    {
      pitch: 3,
      blur: .6,
      length: 15,
      width: 6,
      tolerance: 9,
      error: 2.8,
      opacity: .92,
      noise: .68,
      seconds: 18
    },
    {
      pitch: 2,
      blur: 0,
      length: 9.5,
      width: 3.2,
      tolerance: 7,
      error: 4.6,
      opacity: .94,
      noise: .42,
      seconds: 17
    },
    {
      pitch: 1,
      blur: 0,
      length: 6.2,
      width: 1.7,
      tolerance: 5.8,
      error: 8.2,
      opacity: .94,
      noise: .28,
      seconds: 13
    },
  ];
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const byte = n => clamp(Math.round(n), 0, 255);

  function randomSource(pixels) {
    let state = pixels.length ^ 2166136261;
    const hop = Math.max(1, Math.floor(pixels.length / 929));
    for (let i = 0; i < pixels.length; i += hop) state = Math.imul(state ^ pixels[i], 16777619);
    return () => {
      state = (state + 0x6D2B79F5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function referenceColors(rgba, w, h) {
    const colors = new Uint8ClampedArray(w * h * 3);
    for (let p = 0; p < w * h; p++) {
      const a = rgba[4 * p + 3] / 255,
        k = 3 * p;
      if (a === 1) {
        colors[k] = rgba[4 * p];
        colors[k + 1] = rgba[4 * p + 1];
        colors[k + 2] = rgba[4 * p + 2];
        continue;
      }
      // Transparent areas become a painted backdrop. Opaque photographs keep their own background.
      const x = (p % w) / w,
        y = Math.floor(p / w) / h;
      const glow = Math.exp(-(((x - .24) / .56) ** 2) - (((y - .27) / .64) ** 2));
      const warm = Math.exp(-(((x + .14) / .51) ** 2) - (((y - .48) / .60) ** 2));
      colors[k] = a * rgba[4 * p] + (1 - a) * (30 + 51 * glow + 16 * warm);
      colors[k + 1] = a * rgba[4 * p + 1] + (1 - a) * (45 + 49 * glow + 6 * warm);
      colors[k + 2] = a * rgba[4 * p + 2] + (1 - a) * (49 + 40 * glow - 5 * warm);
    }
    return colors;
  }

  function colorPyramid(colors, w, h) {
    const stride = (w + 1) * 3,
      sums = new Uint32Array(stride * (h + 1));
    for (let y = 0; y < h; y++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let x = 0; x < w; x++) {
        const i = 3 * (y * w + x),
          d = (y + 1) * stride + 3 * (x + 1);
        r += colors[i];
        g += colors[i + 1];
        b += colors[i + 2];
        sums[d] = sums[d - stride] + r;
        sums[d + 1] = sums[d - stride + 1] + g;
        sums[d + 2] = sums[d - stride + 2] + b;
      }
    }
    return radius => {
      if (radius <= 0) return colors;
      const out = new Uint8ClampedArray(colors.length);
      for (let y = 0; y < h; y++) {
        const top = Math.max(0, y - radius),
          bot = Math.min(h, y + radius + 1);
        for (let x = 0; x < w; x++) {
          const left = Math.max(0, x - radius),
            right = Math.min(w, x + radius + 1);
          const a = top * stride + left * 3,
            b = top * stride + right * 3,
            c = bot * stride + left * 3,
            d = bot * stride + right * 3;
          const inv = 1 / ((bot - top) * (right - left)),
            i = (y * w + x) * 3;
          for (let ch = 0; ch < 3; ch++) out[i + ch] = (sums[d + ch] - sums[b + ch] - sums[c + ch] +
            sums[a +
              ch]) * inv;
        }
      }
      return out;
    };
  }

  function directionField(colors, w, h, cell) {
    const fw = Math.ceil(w / cell),
      fh = Math.ceil(h / cell);
    const p = new Float32Array(fw * fh),
      q = new Float32Array(fw * fh),
      energy = new Float32Array(fw * fh);
    const weights = [.27, .54, .19];
    for (let y = 0; y < h; y++) {
      const above = Math.max(0, y - 1) * w,
        below = Math.min(h - 1, y + 1) * w,
        fieldY = Math.floor(y / cell) * fw;
      for (let x = 0; x < w; x++) {
        const l = 3 * (y * w + Math.max(0, x - 1)),
          r = 3 * (y * w + Math.min(w - 1, x + 1));
        const a = 3 * (above + x),
          b = 3 * (below + x),
          k = fieldY + Math.floor(x / cell);
        for (let ch = 0; ch < 3; ch++) {
          const dx = (colors[r + ch] - colors[l + ch]) * .5,
            dy = (colors[b + ch] - colors[a + ch]) * .5;
          p[k] += weights[ch] * (dx * dx - dy * dy);
          q[k] += weights[ch] * 2 * dx * dy;
          energy[k] += weights[ch] * (dx * dx + dy * dy);
        }
      }
    }
    const vx = new Float32Array(fw * fh),
      vy = new Float32Array(fw * fh),
      strength = new Float32Array(fw * fh);
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        let sp = 0,
          sq = 0,
          se = 0,
          sw = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(fh - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(fw - 1, x + 1); xx++) {
            const wt = (xx === x ? 2 : 1) * (yy === y ? 2 : 1),
              k = yy * fw + xx;
            sp += wt * p[k];
            sq += wt * q[k];
            se += wt * energy[k];
            sw += wt;
          }
        }
        const k = y * fw + x,
          mag = Math.hypot(sp, sq),
          grad = Math.sqrt(se / (sw * cell * cell));
        // In flat regions use long sweeping marks. At an edge follow its tangent in either direction.
        const ambient = -.82 + .51 * Math.sin(x * cell / w * 5 + y * cell / h * 2) + .27 * Math.cos(y *
          cell / h *
          6);
        const weight = Math.min(1, grad / 2) * Math.min(1, 1.8 * mag / (se + .01));
        const a = .5 * Math.atan2((1 - weight) * Math.sin(2 * ambient) - weight * sq / (mag + .001),
          (1 - weight) * Math.cos(2 * ambient) - weight * sp / (mag + .001));
        vx[k] = Math.cos(a);
        vy[k] = Math.sin(a);
        strength[k] = grad;
      }

    function at(x, y) {
      return clamp(Math.floor(y / cell), 0, fh - 1) * fw + clamp(Math.floor(x / cell), 0, fw - 1);
    }
    return {
      vx,
      vy,
      strength,
      at
    };
  }

  function colorLoss(colors, a, b) {
    return .30 * Math.abs(colors[a] - colors[b]) + .46 * Math.abs(colors[a + 1] - colors[b + 1]) + .24 *
      Math.abs(
        colors[a + 2] - colors[b + 2]);
  }

  function candidates(colors, painted, w, h, step, threshold, budget, rng) {
    const nx = Math.ceil(w / step),
      ny = Math.ceil(h / step),
      picks = new Uint32Array(nx * ny);
    let size = 0;
    for (let y = 0; y < h; y += step)
      for (let x = 0; x < w; x += step) {
        const cw = Math.min(step, w - x),
          ch = Math.min(step, h - y);
        let score = -1,
          point = 0;
        const n = threshold === 0 ? 1 : Math.min(cw * ch, step > 3 ? 9 : 5);
        const offset = Math.floor(rng() * cw * ch);
        for (let s = 0; s < n; s++) {
          const j = (offset + Math.floor(s * cw * ch / n)) % (cw * ch),
            p = (y + Math.floor(j / cw)) * w + x + (j % cw);
          const i = 3 * p,
            k = 4 * p;
          const error = threshold === 0 ? 1 : .30 * Math.abs(colors[i] - painted[k]) + .46 * Math.abs(
            colors[i +
              1] - painted[k + 1]) + .24 * Math.abs(colors[i + 2] - painted[k + 2]);
          if (error > score) {
            score = error;
            point = p;
          }
        }
        if (threshold === 0 || score > threshold * (.86 + .28 * rng())) picks[size++] = point;
      }
    for (let i = size - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1)),
        v = picks[i];
      picks[i] = picks[j];
      picks[j] = v;
    }
    return picks.subarray(0, Math.min(size, budget));
  }

  function planStrokes(pass, idx, colors, field, picks, w, h, unit, rng) {
    const data = new ArrayBuffer(picks.length * Pincel.stride),
      view = new DataView(data);
    const pix = (x, y) => 3 * (clamp(Math.round(y), 0, h - 1) * w + clamp(Math.round(x), 0, w - 1));

    function trace(x, y, dx, dy, range, color, tolerance) {
      const step = range / 3;
      for (let j = 0; j < 3; j++) {
        const near = field.at(x + dx * step * .55, y + dy * step * .55);
        let vx = field.vx[near],
          vy = field.vy[near];
        if (vx * dx + vy * dy < 0) {
          vx = -vx;
          vy = -vy;
        }
        dx = .58 * dx + .42 * vx;
        dy = .58 * dy + .42 * vy;
        const norm = Math.hypot(dx, dy) || 1;
        dx /= norm;
        dy /= norm;
        const nx = x + dx * step,
          ny = y + dy * step;
        const loss = colorLoss(colors, color, pix(nx, ny));
        if (loss > tolerance) {
          const k = clamp(.82 * tolerance / loss, .12, .95);
          x += dx * step * k;
          y += dy * step * k;
          break;
        }
        x = nx;
        y = ny;
      }
      return [x, y];
    }
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i],
        color = 3 * p;
      const x = p % w + (rng() - .5) * .36,
        y = Math.floor(p / w) + (rng() - .5) * .36;
      const dir = field.at(x, y),
        g = field.strength[dir];
      const spin = (rng() - .5) * (idx < 2 ? .52 : g < 2 ? .26 : .14),
        cs = Math.cos(spin),
        sn = Math.sin(spin);
      const dx = field.vx[dir] * cs - field.vy[dir] * sn,
        dy = field.vx[dir] * sn + field.vy[dir] * cs;
      const length = Math.max(1.4, pass.length * unit) * (.76 + .47 * rng());
      const width = Math.max(.82, pass.width * unit) * (.76 + .45 * rng());
      const tol = pass.tolerance;
      let diameter = width,
        shift = 0;
      if (idx >= 2) {
        const half = width * .5,
          amin = idx < 4 ? .47 : .18;
        const gap1 = colorLoss(colors, color, pix(x - dy * half, y + dx * half));
        const gap2 = colorLoss(colors, color, pix(x + dy * half, y - dx * half));
        const left = half * clamp(tol / (gap1 + .1), amin, 1),
          right = half * clamp(tol / (gap2 + .1), amin, 1);
        diameter = left + right;
        shift = (left - right) * .32;
      }
      const cx = x - dy * shift,
        cy = y + dx * shift;
      let ang = Math.atan2(dy, dx),
        span = length,
        bend = (rng() - .5) * length * .12;
      let mx = cx,
        my = cy;
      if (idx >= 1) {
        const a = trace(cx, cy, -dx, -dy, length * .5, color, tol),
          b = trace(cx, cy, dx, dy, length * .5, color, tol);
        mx = (a[0] + b[0]) * .5;
        my = (a[1] + b[1]) * .5;
        const ax = b[0] - a[0],
          ay = b[1] - a[1];
        span = Math.max(.62, Math.hypot(ax, ay));
        ang = Math.atan2(ay, ax);
        const nx = -ay / span,
          ny = ax / span;
        bend = clamp((cx - mx) * nx + (cy - my) * ny, -span * .22, span * .22);
        mx += nx * bend;
        my += ny * bend;
        diameter = Math.min(diameter, span * (idx < 3 ? .98 : .87));
      }
      if (rng() > .5) {
        ang = ang > 0 ? ang - Math.PI : ang + Math.PI;
        bend = -bend;
      }
      const off = i * Pincel.stride;
      view.setInt16(off, Math.round(mx * 8), true);
      view.setInt16(off + 2, Math.round(my * 8), true);
      view.setInt16(off + 4, Math.round(ang * 4000), true);
      view.setInt16(off + 6, Math.round(span * 32), true);
      view.setInt16(off + 8, Math.max(18, Math.round(diameter * 64)), true);
      view.setInt16(off + 10, Math.round(bend * 32), true);
      view.setInt16(off + 12, Math.round((rng() - .5) * Math.min(span * .07, diameter * .24) * 32), true);
      const val = (rng() + rng() - 1) * pass.noise,
        hue = (rng() - .5) * pass.noise * .65;
      view.setUint8(off + 14, byte(colors[color] + val + hue));
      view.setUint8(off + 15, byte(colors[color + 1] + val * .92));
      view.setUint8(off + 16, byte(colors[color + 2] + val * .80 - hue));
      view.setUint8(off + 17, byte(pass.opacity * 255));
      view.setUint16(off + 18, Math.floor(rng() * 65536), true);
      view.setUint8(off + 20, idx < 2 ? 0 : idx >= 6 ? 4 : g > 6 ? 3 : 2);
    }
    return data;
  }
  let pendingSurface;
  function requestSurface(message) {
    return new Promise((resolve, reject) => {
      pendingSurface = {resolve, reject};
      self.postMessage({type: 'surface', ...message}, message.buffer ? [message.buffer] : []);
    });
  }
  async function paint({pixels, w, h, outputWidth, outputHeight, ground}) {
    const unit = Math.max(w, h) / 1050;
    const expectedSeconds = passes.reduce((total, pass) => total + pass.seconds, 0);
    const target = referenceColors(new Uint8ClampedArray(pixels), w, h);
    const rng = randomSource(target),
      smooth = colorPyramid(target, w, h);
    const dimensions = {w, h, outputWidth, outputHeight, ground};
    let render;
    try {
      render = createSurface(dimensions, false);
    } catch {
      await requestSurface({op: 'init', ...dimensions});
      render = requestSurface;
    }
    let lastRadius = -1,
      lastCell = -1,
      colors, field;
    let strokesSinceKeyframe = 0;
    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i],
        step = Math.max(1, Math.round(pass.pitch * unit)),
        radius = Math.round(pass.blur * unit);
      const cell = Math.max(1, Math.round(Math.max(2, pass.pitch * .52) * unit));
      if (radius !== lastRadius) colors = smooth(radius);
      if (radius !== lastRadius || cell !== lastCell) field = directionField(colors, w, h, cell);
      lastRadius = radius;
      lastCell = cell;
      let painted = null;
      if (pass.error > 0) {
        const sample = await render({op: 'sample'});
        painted = new Uint8ClampedArray(sample.pixels);
      }
      const limit = i >= 6 ? Math.max(3000, Math.round(w * h * (i === 6 ? .15 : .18))) : w * h;
      const points = candidates(colors, painted, w, h, step, pass.error, limit, rng);
      if (!points.length) continue;
      const records = planStrokes(pass, i, colors, field, points, w, h, unit, rng);
      // This is the exact starting canvas for this pass, already painted by the planner.
      // Sparse lossless snapshots let a phone skip thousands of earlier strokes during a drag.
      const snapshot = strokesSinceKeyframe >= 2048;
      const {buffer, checkpoint} = await render({op: 'paint', buffer: records, count: points.length, snapshot});
      if (snapshot) strokesSinceKeyframe = 0;
      strokesSinceKeyframe += points.length;
      // A finished pass can play while the next pass evaluates the current painting.
      const seconds = Math.min(pass.seconds, Math.max(.8, points.length / 60));
      self.postMessage({
        type: 'pass',
        index: i,
        total: passes.length,
        seconds,
        expectedSeconds,
        count: points.length,
        buffer,
        checkpoint
      }, [buffer]);
    }
    const {png} = await render({op: 'finish'});
    self.postMessage({
      type: 'complete',
      png
    });
  }
  self.onmessage = ({data}) => {
    if (data.type === 'surfaceResult') {
      const reply = pendingSurface;
      pendingSurface = null;
      if (data.error) reply.reject(new Error('Canvas rendering failed'));
      else reply.resolve(data);
      return;
    }
    paint(data).catch(() => self.postMessage({
      type: 'error'
    }));
  };
})();
