(function installBrush(root) {
  const stride = 24;
  const channel = value => Math.max(0, Math.min(255, Math.round(value)));

  function rgb(r, g, b, delta = 0) {
    return 'rgb(' + channel(r + delta) + ',' + channel(g + delta * .91) + ',' + channel(b + delta * .74) +
      ')';
  }

  function mark(ctx, data, index) {
    const at = index * stride,
      s16 = offset => data.getInt16(at + offset, true);
    const x = s16(0) / 8,
      y = s16(2) / 8,
      angle = s16(4) / 4000;
    const length = s16(6) / 32,
      width = s16(8) / 64;
    const bend = s16(10) / 32,
      wave = s16(12) / 32;
    const r = data.getUint8(at + 14),
      g = data.getUint8(at + 15),
      b = data.getUint8(at + 16);
    const alpha = data.getUint8(at + 17) / 255,
      style = data.getUint8(at + 20);
    let seed = data.getUint16(at + 18, true) + 1;

    function rand() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    const smooth = style === 2,
      hair = style === 3 || style === 4;
    const half = width / 2,
      left = -length / 2,
      right = length / 2;
    const tilt = (rand() - .5) * .27,
      body = .79 + rand() * .25;

    function center(t) {
      const u = 2 * t - 1;
      return -bend * u * u + wave * u * (1 - u * u);
    }

    function edge(t) {
      return Math.sin(Math.PI * t) ** (hair ? .79 : smooth ? .59 : .37);
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgb(r, g, b);
    ctx.beginPath();
    ctx.moveTo(left, center(0));
    ctx.bezierCurveTo(left + length * .02, center(.02) - half * (hair ? .15 : .63),
      left + length * .20, center(.2) - half * (1.12 + tilt),
      left + length * .43, center(.43) - half);
    ctx.bezierCurveTo(left + length * .64, center(.64) - half * body,
      left + length * .92, center(.92) - half * (hair ? .28 : .72), right, center(1));
    ctx.bezierCurveTo(right - length * .035, center(.965) + half * (hair ? .15 : .62),
      left + length * .70, center(.7) + half * (1 + tilt), left + length * .47, center(.47) + half);
    ctx.bezierCurveTo(left + length * .22, center(.22) + half * (1.04 - tilt),
      left + length * .065, center(.065) + half * (hair ? .38 : .73), left, center(0));
    ctx.closePath();
    ctx.fill();
    const strands = width < 2.3 ? 0 : Math.min(style === 0 ? 13 : 8, Math.max(1, Math.floor(width * (
      smooth ? .29 : .40))));
    ctx.lineCap = 'round';
    for (let n = 0; n < strands; n++) {
      const offset = ((n + rand()) / strands * 2 - 1) * half * .96;
      const a = rand() * .22,
        z = .72 + rand() * .27,
        m = (a + z) * .5;
      const value = (rand() > .39 ? 1 : -1) * (7 + 18 * rand()) * (smooth ? .64 : 1);
      ctx.strokeStyle = rgb(r, g, b, value);
      ctx.globalAlpha = alpha * ((smooth ? .19 : .26) + rand() * .21);
      ctx.lineWidth = Math.max(.27, Math.min(style === 0 ? 2.3 : 1.1, width * (.015 + .027 * rand())));
      const y0 = center(a) + offset * edge(a),
        y1 = center(z) + offset * edge(z);
      const ym = center(m) + offset * edge(m);
      ctx.beginPath();
      ctx.moveTo(left + a * length, y0);
      ctx.quadraticCurveTo(left + m * length, 2 * ym - .5 * (y0 + y1), left + z * length, y1);
      ctx.stroke();
    }
    ctx.restore();
  }
  const painter = {
    stride,
    mark
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = painter;
  else {
    root.Pincel = painter;
    // A file:// workshop cannot import a neighbouring worker script. The portable worker
    // runs this same brush implementation inside a blob worker.
    if (typeof document !== 'undefined') root.installStudioBrush = installBrush;
  }
})(typeof window === 'undefined' ? globalThis : window);
