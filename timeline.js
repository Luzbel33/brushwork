// Playback and seeking share the exact same stroke records and brush.
async function readStrokePass(item) {
  if (item.view) return item.view;
  if (!item.bytes) {
    if (item.encoded) {
      item.bytes = Uint8Array.from(atob(item.encoded), c => c.charCodeAt(0));
    } else {
      item.request ??= fetch(item.file).then(response => {
        if (!response.ok) throw new Error('Could not load a stroke pass');
        return response.arrayBuffer();
      });
      item.bytes = new Uint8Array(await item.request);
    }
  }
  if (item.bytes.byteLength !== item.count * Pincel.stride) throw new Error('Incomplete stroke pass');
  item.view = new DataView(item.bytes.buffer, item.bytes.byteOffset, item.bytes.byteLength);
  return item.view;
}

class StrokeTimeline {
  constructor(piece, ground) {
    this.piece = piece;
    this.ground = ground;
    this.frames = new Map();
    this.bytes = 0;
    this.drawn = -1;
  }

  remember(at, blob) {
    if (!blob || this.piece.disposed || this.frames.has(at)) return;
    // Keep decoded memory to one working canvas. Stored keyframes are lossless PNGs.
    const budget = 24 * 1024 * 1024;
    if (blob.size > budget) return;
    while (this.bytes + blob.size > budget) {
      const oldest = this.frames.keys().next().value;
      this.bytes -= this.frames.get(oldest).size;
      this.frames.delete(oldest);
    }
    this.frames.set(at, blob);
    this.bytes += blob.size;
  }

  async frameAt(fraction, current) {
    const piece = this.piece;
    const time = fraction * piece.duration;
    const index = piece.stages.findIndex(item => time < item.before + item.seconds);
    const selected = piece.stages[index];
    const mark = Math.max(0, Math.min(selected.count, Math.floor((time - selected.before) / selected.seconds * selected.count)));
    const target = selected.first + mark;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = piece.width;
      this.canvas.height = piece.height;
      this.ctx = this.canvas.getContext('2d', {alpha: false, willReadFrequently: true});
    }
    const ctx = this.ctx;
    let anchor = 0;
    for (const at of this.frames.keys()) if (at <= target && at > anchor) anchor = at;
    if (this.drawn < anchor || this.drawn > target) {
      const bitmap = anchor ? await createImageBitmap(this.frames.get(anchor)) : null;
      if (!current()) {bitmap?.close(); return;}
      ctx.resetTransform();
      if (bitmap) {
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      } else {
        ctx.fillStyle = this.ground;
        ctx.fillRect(0, 0, piece.width, piece.height);
      }
      ctx.scale(piece.width / piece.w, piece.height / piece.h);
      this.drawn = anchor;
    }
    for (const item of piece.stages) {
      const end = item.first + item.count;
      if (this.drawn >= target) break;
      if (end <= this.drawn) continue;
      const data = await readStrokePass(item);
      const until = Math.min(end, target);
      while (this.drawn < until) {
        if (!current()) return;
        const deadline = performance.now() + 7;
        do { Pincel.mark(ctx, data, this.drawn++ - item.first); }
        while (this.drawn < until && performance.now() < deadline);
        if (this.drawn < until) await new Promise(resolve => requestAnimationFrame(resolve));
      }
      // Preset recordings may arrive without keyframes. Index them as they are first visited.
      if (this.drawn === end && end - anchor >= 4096 && !this.frames.has(end)) {
        this.remember(end, await new Promise(resolve => this.canvas.toBlob(resolve, 'image/png')));
        anchor = end;
      }
    }
    const view = await readStrokePass(selected);
    return current() ? {canvas: this.canvas, index, mark, view} : null;
  }

  release() {
    this.frames.clear();
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
  }
}
