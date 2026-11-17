(() => {
  'use strict';
  const id = name => document.getElementById(name);
  const lang = window.StudioLanguage;
  const {
    t
  } = lang;
  const config = window.BrushworkConfig || {};
  const defaultSource = id('reference').getAttribute('src');
  const board = id('art'),
    work = id('work'),
    reference = id('reference');
  const track = id('track');
  const gallery = id('gallery'), layout = id('layout');
  let stackPreference;
  const dialog = id('export-dialog'),
    ground = '#756958';
  const speeds = [0.5, 1, 2, 4];
  const from64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
  let canvas = board,
    ctx = canvas.getContext('2d'),
    editor, frame, editorHtml;
  let active, incoming, snapshot, feedbackKey = '',
    statusKey = 'preparing';
  let mode = 'loading',
    rate = 1,
    pass = 0,
    mark = 0,
    progress = 0;
  let epoch = 0,
    raf = 0,
    timer = 0,
    last = 0,
    carry = 0,
    fetching = false,
    strokes;
  let seekRequest, renderingSeek = false, holdingTrack = false, position = 0;
  const desktop = matchMedia('(min-width: 780px)');
  const percent = n => new Intl.NumberFormat(lang.code, {
    style: 'percent'
  }).format(n / 100);
  const dims = (w, h) => w + ' × ' + h;
  function clock(seconds) {
    const whole = Math.max(0, Math.floor(seconds + 0.000001));
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }

  function renderProgress(value, force = false) {
    const next = Math.min(100, Math.max(0, Math.round(value * 100) / 100));
    if (!force && next === position) return;
    position = next;
    progress = Math.floor(next);
    const duration = active?.expected || 0;
    const stamp = clock(duration * next / 100) + ' / ' + (duration ? clock(duration) : '–:––');
    track.value = String(next);
    track.setAttribute('aria-valuenow', String(next));
    track.style.setProperty('--played', next + '%');
    track.setAttribute('aria-valuetext', stamp + ' · ' + percent(progress));
    if (id('time').textContent !== stamp) id('time').textContent = stamp;
    id('percent').textContent = percent(progress);
  }

  function feedback(key) {
    feedbackKey = key;
    id('file-feedback').textContent = key ? t(key) : '';
    id('file-feedback').hidden = !key;
  }

  function status(key) {
    statusKey = key;
    const item = active?.stages[pass];
    const text = key === 'pass' && item ? (active.stageLabels?.[lang.code]?.[item.index] || lang.stage(
      item.index)) : t(key === 'pass' ? 'preparing' : key);
    if (id('status').textContent !== text) id('status').textContent = text;
    const current = mode === 'final' ? active?.total : item && item.index + 1;
    id('pass').textContent = current ? t('pass', {
      n: current,
      total: active.total
    }) : '';
  }

  function buttons() {
    const playable = active && !['waiting', 'seeking', 'error', 'loading'].includes(mode);
    const paused = mode === 'paused',
      done = mode === 'final';
    id('toggle').disabled = !playable;
    id('toggle').querySelector('span').textContent = t(done ? 'replay' : paused ? 'resume' : 'pause');
    id('toggle').querySelector('use').setAttribute('href', paused || done ? '#i-play' : '#i-pause');
    id('speed').disabled = !playable;
    id('speed').querySelector('bdi').textContent = new Intl.NumberFormat(lang.code).format(rate) + '×';
    id('restart').disabled = !active || mode === 'error';
    id('restart').hidden = done;
    id('final').disabled = !playable || done || Boolean(incoming);
    id('save').disabled = !active || Boolean(incoming) || mode === 'seeking';
    track.disabled = !active?.stages.length || Boolean(incoming) || mode === 'error';
    id('tools').hidden = !active || !desktop.matches || !(config.editor || config.editorData);
    id('tools').textContent = t(frame && !frame.hidden ? 'hideTools' : 'tools');
    id('tools').setAttribute('aria-pressed', String(Boolean(frame && !frame.hidden)));
    if (snapshot) {
      id('current-note').textContent = t('currentNote', {
        n: percent(snapshot.percent)
      });
      id('save-final').disabled = !active.master;
      id('final-note').textContent = active.master ? t('finalNote', {
        size: dims(active.width, active.height)
      }) : t('rendering');
    }
  }

  function updateLayout() {
    const stacked = stackPreference ?? (!active || active.width >= active.height);
    gallery.classList.toggle('is-stacked', stacked);
    const label = t(stacked ? 'sideBySide' : 'stackViews');
    layout.querySelector('span').textContent = label;
    layout.title = label;
  }

  layout.onclick = () => {
    stackPreference = !gallery.classList.contains('is-stacked');
    updateLayout();
  };

  function translate() {
    document.documentElement.lang = lang.code;
    document.title = 'Brushwork · ' + t('studio');
    document.querySelectorAll('[data-t]').forEach(el => {
      el.textContent = t(el.dataset.t);
    });
    document.querySelectorAll('[data-aria]').forEach(el => el.setAttribute('aria-label', t(el.dataset
      .aria)));
    reference.alt = active?.fileLabel ? t('refAlt') + ' · ' + active.fileLabel : t('refAlt');
    if (frame && frame.dataset.language !== lang.code) {
      // Klecks builds many of its labels at startup. Reopen the same layers in the
      // selected language while the player keeps painting the base canvas.
      const project = editor?.project?.() || frame.brushworkProject;
      const hidden = frame.hidden;
      if (editor) {
        const dest = board.getContext('2d');
        dest.save();
        dest.resetTransform();
        dest.clearRect(0, 0, board.width, board.height);
        dest.drawImage(canvas, 0, 0);
        dest.restore();
        canvas = board;
        ctx = dest;
        scale();
      }
      frame.remove();
      frame = editor = null;
      mountEditor(project, hidden);
    }
    id('language').value = lang.code;
    id('project-source').title = t('sourceCode');
    updateLayout();
    renderProgress(position, true);
    status(statusKey);
    feedback(feedbackKey);
    buttons();
  }

  function cancelRun() {
    ++epoch;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = timer = last = carry = 0;
    fetching = false;
    strokes = null;
  }

  function scale() {
    ctx.setTransform(canvas.width / active.w, 0, 0, canvas.height / active.h, 0, 0);
  }

  function mirror() {
    const dest = board.getContext('2d');
    dest.save();
    dest.resetTransform();
    dest.clearRect(0, 0, board.width, board.height);
    dest.drawImage(editor.composite?.() || canvas, 0, 0);
    dest.restore();
  }

  function updateSurface(record = false) {
    if (!editor) return;
    if (record) editor.record();
    if (frame.hidden) mirror();
    else editor.refresh();
  }

  function repaint(image, record = true) {
    ctx.save();
    ctx.resetTransform();
    if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    else {
      ctx.fillStyle = ground;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
    scale();
    updateSurface(record);
  }

  function mountEditor(project, hidden = false) {
    frame = document.createElement('iframe');
    frame.hidden = hidden;
    frame.brushworkProject = project;
    frame.title = t('tools');
    frame.className = 'loading';
    Object.assign(frame.dataset, {
      taller: 'retrato',
      paintWidth: active.width,
      paintHeight: active.height,
      language: lang.code
    });
    if (config.editorData) {
      editorHtml ??= new TextDecoder().decode(from64(config.editorData));
      frame.srcdoc = editorHtml;
    } else frame.src = config.editor;
    work.append(frame);
  }

  function toggleEditor() {
    if (!active || !desktop.matches) return;
    if (frame) {
      frame.hidden = !frame.hidden;
      if (editor && frame.hidden) mirror();
      else editor?.refresh();
    } else mountEditor();
    work.classList.toggle('is-editing', !frame.hidden);
    buttons();
  }
  window.addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.data?.type !== 'taller-listo') return;
    // Chromium gives a local srcdoc frame an opaque origin even when its parent
    // reports file://. Only accept it from the particular frame we created.
    const localDocument = config.editorData && location.protocol === 'file:' && event.origin ===
      'null';
    if (!localDocument && event.origin !== location.origin) return;
    const native = frame.contentWindow.pinturaLocal;
    if (!native || native.canvas.width !== active.width || native.canvas.height !== active.height)
      return;
    const surface = native.canvas.getContext('2d');
    surface.save();
    surface.resetTransform();
    surface.clearRect(0, 0, canvas.width, canvas.height);
    surface.drawImage(board, 0, 0);
    surface.restore();
    editor = native;
    canvas = native.canvas;
    ctx = surface;
    scale();
    delete frame.brushworkProject;
    updateSurface(true);
    frame.className = '';
  });
  desktop.addEventListener('change', () => {
    if (!desktop.matches && frame) {
      frame.hidden = true;
      work.classList.remove('is-editing');
      if (editor) mirror();
    }
    buttons();
  });

  function dispose(piece) {
    if (!piece) return;
    piece.disposed = true;
    piece.worker?.terminate();
    for (const url of [piece.photoUrl, piece.masterUrl])
      if (url) URL.revokeObjectURL(url);
    piece.stages.length = 0;
    piece.timeline?.release();
    piece.master = null;
  }

  function activate(piece) {
    if (dialog.open) dialog.close();
    const previous = active;
    seekRequest = null;
    holdingTrack = false;
    cancelRun();
    frame?.remove();
    frame = editor = null;
    work.classList.remove('is-editing');
    active = piece;
    piece.timeline = new StrokeTimeline(piece, ground);
    if (incoming === piece) incoming = null;
    canvas = board;
    board.width = piece.width;
    board.height = piece.height;
    ctx = board.getContext('2d');
    reference.src = piece.source;
    reference.alt = piece.fileLabel ? t('refAlt') + ' · ' + piece.fileLabel : t('refAlt');
    gallery.style.setProperty('--aspect', String(piece.width / piece.height));
    updateLayout();
    id('source-size').textContent = dims(piece.sourceWidth, piece.sourceHeight);
    mark = pass = 0;
    mode = 'playing';
    renderProgress(0, true);
    feedback('');
    status('preparing');
    repaint(null);
    buttons();
    dispose(previous);
    advance();
  }

  function fail(piece, key) {
    if (piece.disposed) return;
    if (piece === incoming) {
      incoming = null;
      dispose(piece);
      if (!active) {
        mode = 'error';
        status('interrupted');
      }
    } else if (piece === active) {
      cancelRun();
      seekRequest = null;
      piece.worker?.terminate();
      mode = 'error';
      status('interrupted');
    } else return;
    feedback(key);
    buttons();
  }

  function showFinal() {
    if (!active || mode === 'error') return;
    seekRequest = null;
    cancelRun();
    if (!active.master) {
      mode = 'waiting';
      status('rendering');
      buttons();
      return;
    }
    mode = 'final';
    repaint(active.master.image);
    renderProgress(100);
    status('done');
    buttons();
  }

  function restart() {
    if (!active) return;
    seekRequest = null;
    cancelRun();
    mark = pass = 0;
    mode = 'playing';
    repaint(null);
    renderProgress(0, true);
    status('preparing');
    buttons();
    advance();
  }

  function pause() {
    mode = 'paused';
    cancelAnimationFrame(raf);
    last = 0;
    status('paused');
    buttons();
  }

  function resume() {
    mode = 'playing';
    last = 0;
    buttons();
    if (strokes) {
      status('pass');
      raf = requestAnimationFrame(draw);
    } else advance();
  }

  function appendPass(piece, item) {
    item.before = piece.duration;
    item.first = piece.count || 0;
    piece.count = item.first + item.count;
    piece.duration += item.seconds;
    piece.stages.push(item);
  }
  async function advance() {
    if (!active || strokes || fetching || (mode !== 'playing' && mode !== 'paused')) return;
    const piece = active,
      ticket = epoch,
      item = piece.stages[pass];
    if (!item) {
      if (piece.master && mode === 'playing') {
        showFinal();
        return;
      }
      status(mode === 'paused' ? 'paused' : pass ? 'next' : 'preparing');
      return;
    }
    fetching = true;
    try {
      const view = await readStrokePass(item);
      if (ticket !== epoch) return;
      strokes = view;
      last = mark = carry = 0;
      status(mode === 'paused' ? 'paused' : 'pass');
      if (mode === 'playing') raf = requestAnimationFrame(draw);
    } catch {
      if (ticket === epoch) fail(piece, 'readError');
    } finally {
      if (ticket === epoch) fetching = false;
    }
  }

  function draw(now) {
    if (mode !== 'playing' || !strokes) return;
    const item = active.stages[pass];
    const elapsed = last ? Math.min((now - last) / 1000, .16) : .017;
    last = now;
    carry += elapsed * rate * item.count / item.seconds;
    const until = Math.min(item.count, mark + Math.floor(carry)),
      deadline = performance.now() + 11;
    while (mark < until && performance.now() < deadline) {
      Pincel.mark(ctx, strokes, mark++);
      carry--;
    }
    updateSurface(mark === item.count);
    const seconds = item.before + item.seconds * mark / item.count;
    renderProgress(Math.min(99.99, 100 * seconds / active.expected));
    if (mark < item.count) {
      raf = requestAnimationFrame(draw);
      return;
    }
    strokes = null;
    pass++;
    last = 0;
    const ticket = epoch;
    timer = setTimeout(() => {
      if (ticket === epoch) advance();
    }, 90);
  }
  async function setMaster(piece, url) {
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (piece.disposed) return;
      if (image.naturalWidth !== piece.width || image.naturalHeight !== piece.height) throw Error();
      piece.master = {
        image,
        url
      };
      buttons();
      pumpSeek();
      if (active === piece && (mode === 'waiting' || (mode === 'playing' && pass >= piece.stages
          .length))) showFinal();
    } catch {
      fail(piece, 'renderError');
    }
  }

  function receive(piece, data) {
    if (piece.disposed || (piece !== active && piece !== incoming)) return;
    if (data.type === 'pass') {
      piece.total = data.total;
      piece.expected = data.expectedSeconds;
      appendPass(piece, {
        index: data.index,
        seconds: data.seconds,
        count: data.count,
        bytes: new Uint8Array(data.buffer)
      });
      if (incoming === piece) activate(piece);
      else advance();
      if (data.checkpoint) piece.timeline.remember(piece.stages.at(-1).first, data.checkpoint);
    } else if (data.type === 'complete') {
      piece.worker.terminate();
      piece.worker = null;
      piece.expected = piece.duration;
      piece.durationKnown = true;
      if (mode === 'seeking' && piece === active) renderProgress(position, true);
      pumpSeek();
      piece.masterUrl = URL.createObjectURL(data.png);
      setMaster(piece, piece.masterUrl);
    } else if (data.type === 'error') fail(piece, 'renderError');
  }

  function scaledSize(w, h, limit) {
    const f = Math.min(1, limit / Math.max(w, h));
    return [Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))];
  }
  async function loadPhoto(source, name, photoUrl, fileLabel = name) {
    dispose(incoming);
    const piece = {
      source,
      name,
      photoUrl,
      fileLabel,
      stages: [],
      duration: 0,
      expected: 1
    };
    incoming = piece;
    feedback('opening');
    buttons();
    try {
      const img = new Image();
      img.src = source;
      await img.decode();
      if (incoming !== piece) return;
      piece.sourceWidth = img.naturalWidth;
      piece.sourceHeight = img.naturalHeight;
      if (!piece.sourceWidth || !piece.sourceHeight) throw Error();
      if (typeof Worker === 'undefined') {
        fail(piece, 'engine');
        return;
      }
      [piece.w, piece.h] = scaledSize(piece.sourceWidth, piece.sourceHeight, 1050);
      [piece.width, piece.height] = scaledSize(piece.sourceWidth, piece.sourceHeight, 1600);
      const scan = document.createElement('canvas');
      scan.width = piece.w;
      scan.height = piece.h;
      const context = scan.getContext('2d', {
        willReadFrequently: true
      });
      context.imageSmoothingQuality = 'high';
      context.drawImage(img, 0, 0, piece.w, piece.h);
      const pixels = context.getImageData(0, 0, piece.w, piece.h).data.buffer;
      scan.width = scan.height = 1;
      piece.worker = window.createPaintingWorker();
      piece.worker.onmessage = ({
        data
      }) => receive(piece, data);
      piece.worker.onerror = () => fail(piece, 'renderError');
      feedback('preparing');
      piece.worker.postMessage({
        pixels,
        w: piece.w,
        h: piece.h,
        outputWidth: piece.width,
        outputHeight: piece.height,
        ground
      }, [pixels]);
    } catch {
      if (piece === incoming) fail(piece, 'invalid');
    }
  }
  async function loadPreset(preset) {
    const piece = {
      ...preset,
      source: defaultSource,
      preset: true,
      stages: [],
      duration: 0,
      expected: 1
    };
    activate(piece);
    try {
      let plan = preset.plan;
      if (!plan) {
        const response = await fetch(preset.planUrl);
        if (!response.ok) throw Error();
        plan = await response.json();
      }
      if (piece.disposed) return;
      plan.stages.forEach((item, i) => appendPass(piece, {
        ...item,
        index: i,
        encoded: preset.data?.[i]
      }));
      piece.total = plan.stages.length;
      piece.expected = piece.duration;
      piece.durationKnown = true;
      renderProgress(position, true);
      buttons();
      pumpSeek();
      advance();
      await setMaster(piece, preset.finalPng || plan.finalFile);
    } catch {
      fail(piece, 'presetError');
    }
  }

  function finishSeek(request) {
    if (seekRequest !== request || !request.painted || holdingTrack) return;
    seekRequest = null;
    if (request.value === 100) {
      mode = 'final';
      status('done');
    } else if (request.resume) {
      resume();
    } else {
      mode = 'paused';
      status('paused');
    }
    if (editor) updateSurface(true);
    buttons();
  }

  async function pumpSeek() {
    const request = seekRequest;
    if (renderingSeek || !request || request.painted) return;
    const piece = request.piece;
    if (request.value === 100 && !piece.master) return;
    if (request.value > 0 && !piece.durationKnown) return;
    renderingSeek = true;
    const current = () => seekRequest === request && active === piece;
    try {
      let image = null;
      if (request.value === 100) {
        image = piece.master.image;
        pass = piece.stages.length - 1;
      } else if (request.value === 0) {
        pass = mark = 0;
      } else {
        const frame = await piece.timeline.frameAt(request.value / 100, current);
        if (!current() || !frame) return;
        image = frame.canvas;
        pass = frame.index;
        mark = frame.mark;
        strokes = frame.view;
      }
      repaint(image, false);
      request.painted = true;
      status(request.value === 100 ? 'done' : 'pass');
      finishSeek(request);
    } catch {
      if (current()) fail(piece, 'readError');
    } finally {
      renderingSeek = false;
      if (seekRequest && seekRequest !== request) pumpSeek();
    }
  }

  function seekTo(value) {
    if (track.disabled) return;
    const selected = Math.max(0, Math.min(100, Math.round(value * 100) / 100));
    if (seekRequest?.value === selected) return;
    const resumeAfter = seekRequest?.resume ?? mode === 'playing';
    cancelRun();
    seekRequest = {piece: active, value: selected, resume: resumeAfter, painted: false};
    mode = 'seeking';
    renderProgress(selected, true);
    status('seeking');
    buttons();
    pumpSeek();
  }
  track.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || track.disabled) return;
    holdingTrack = true;
    track.setPointerCapture(event.pointerId);
    seekTo(Number(track.value));
  });
  track.addEventListener('input', () => seekTo(Number(track.value)));
  function releaseTrack() {
    if (!holdingTrack) return;
    holdingTrack = false;
    if (seekRequest) finishSeek(seekRequest);
  }
  track.addEventListener('pointerup', releaseTrack);
  track.addEventListener('pointercancel', releaseTrack);
  track.addEventListener('lostpointercapture', releaseTrack);
  track.addEventListener('keydown', event => {
    const seconds = event.shiftKey ? 1 : 5;
    const step = 100 * seconds / (active?.expected || 100);
    const keys = {ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -10, PageUp: 10};
    if (event.key !== 'Home' && event.key !== 'End' && !Object.hasOwn(keys, event.key)) return;
    event.preventDefault();
    seekTo(event.key === 'Home' ? 0 : event.key === 'End' ? 100 : Number(track.value) + keys[event.key]);
  });

  function download(url, name) {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  function openExport() {
    if (!active || incoming || mode === 'seeking') return false;
    if (dialog.open) return true;
    const playing = mode === 'playing';
    if (playing) pause();
    // toBlob takes a snapshot when called. Waiting in the dialog never changes the chosen frame.
    const blob = editor?.png ? editor.png() : new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    snapshot = {
      piece: active,
      percent: progress,
      playing,
      blob: Promise.resolve(blob).catch(() => null)
    };
    buttons();
    dialog.showModal();
    id('save-current').focus();
    return true;
  }
  window.guardarRetratoFinal = openExport;
  id('save-current').onclick = async () => {
    const item = snapshot;
    if (!item) return;
    const blob = await item.blob;
    if (!dialog.open || snapshot !== item || active !== item.piece) return;
    if (!blob) {
      feedback('saveError');
      dialog.close();
      return;
    }
    const url = URL.createObjectURL(blob);
    download(url, item.piece.name + '-frame-' + item.percent + 'pct.png');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    dialog.close();
  };
  id('save-final').onclick = () => {
    if (!active.master || snapshot?.piece !== active) return;
    download(active.master.url, active.finalName || active.name + '-painting.png');
    dialog.close();
  };
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const item = snapshot;
    snapshot = null;
    if (item?.playing && active === item.piece && mode === 'paused') resume();
  });
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog
      .close();
  });
  id('close-export').onclick = () => dialog.close();
  id('save').onclick = openExport;
  id('toggle').onclick = () => {
    if (mode === 'final') restart();
    else if (mode === 'paused') resume();
    else if (mode === 'playing') pause();
  };
  id('restart').onclick = restart;
  id('final').onclick = showFinal;
  id('tools').onclick = toggleEditor;
  id('speed').onclick = () => {
    rate = speeds[(speeds.indexOf(rate) + 1) % speeds.length];
    buttons();
  };
  id('language').onchange = e => {
    lang.set(e.target.value);
    translate();
  };
  id('upload').onclick = () => id('photo-file').click();
  id('photo-file').onchange = e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file),
      name = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 90) || 'Photo';
    loadPhoto(url, name, url, file.name);
  };
  translate();
  if (config.preset) loadPreset(config.preset);
  else loadPhoto(defaultSource, 'Chelsea');
})();
