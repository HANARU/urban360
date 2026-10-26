/* Urban360 Capture Simulator: the Capture Tool's workflow on pre-captured data.
 *
 * The tool keeps two copies of its settings, as the plugin does: what the fields show
 * (staged) and what the level has (applied). Apply Settings copies one to the other,
 * Setup & Verify checks the applied copy with the plugin's own problem codes, and Play
 * "captures" by revealing the stored images of point 000742 for the applied weather.
 */
(function () {
  'use strict';

  const DATA = window.U360_DATA;
  const PANO = window.U360_PANO;
  const NODE = DATA.node;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  const WEATHER = { none: 'None', rain: 'Rain', snow: 'Snow', fog: 'Fog' };
  const WEATHER_WORD = { none: 'Clear', rain: 'Rain', snow: 'Snow', fog: 'Fog' };
  const CHANNELS = { color: 'Color', depth: 'Depth', normal: 'Normal', semantic: 'Semantic' };
  const FILES = { color: 'pos5_color.exr', depth: 'pos5_depth.exr', normal: 'pos5_normal.exr', semantic: 'pos5_semantic.png' };
  // Typical fog densities quoted by the plugin's own help for each weather
  const FOG_DENSITY = { none: '0.0002', rain: '0.04', snow: '0.05', fog: '0.30' };

  // DT_SemanticCategories as shipped with 2.0.0 (ID = Cityscapes trainId + 1)
  const CATEGORIES = [
    [0, 'Unlabeled', [0, 0, 0]], [1, 'Road', [128, 64, 128]], [2, 'Sidewalk', [244, 35, 232]],
    [3, 'Building', [70, 70, 70]], [4, 'Wall', [102, 102, 156]], [5, 'Fence', [190, 153, 153]],
    [6, 'Pole', [153, 153, 153]], [7, 'TrafficLight', [250, 170, 30]], [8, 'TrafficSign', [220, 220, 0]],
    [9, 'Vegetation', [107, 142, 35]], [10, 'Terrain', [152, 251, 152]], [11, 'Sky', [70, 130, 180]],
    [12, 'Person', [220, 20, 60]], [13, 'Vehicle', [0, 0, 142]], [14, 'Ground', [81, 0, 81]],
  ];
  const CAT_BY_RGB = new Map(CATEGORIES.map(([id, name, c]) => [(c[0] << 16) | (c[1] << 8) | c[2], { id, name, c }]));

  const HELP = {
    env: ['Env page', [
      'Env Name names the output folder. Name a run after its condition, for example DTW_Day_Rain; Setup & Verify refuses a name that names a different time of day or weather (S012).',
      'Start Index is the first point number to capture. A stopped run continues from the Start Index given in its run report.',
      'Time of Day and Weather only stage a choice. The level changes when you press Apply Settings.',
      'Level Sky & Lights lists the level\u2019s own sky and light actors that the capture hides, so every world is shot under the plugin\u2019s lighting.']],
    points: ['Points page', [
      'Place Road Spline adds a spline that you draw along a street. Generate Points lays capture points along it every Spline Spacing centimetres and puts them on the ground.',
      'Each point has a Capture Target box. A run captures the ticked points and never changes the boxes. Target All and Skip All set them all.',
      'Renumber IDs renumbers the selected points, or the whole level, after asking first.']],
    capture: ['Capture page', [
      'Capture Stereo records a left and a right eye 6.4 cm apart. Mono records one panorama from the rig centre.',
      'Capture Mode selects the outputs: RGB (Color), Depth, Normal and Semantic.',
      'Group (9) captures nine positions around each point, Local Step apart. Single (1) captures the centre only.',
      'Semantic Option opens the window where actors are given categories.']],
  };

  const DEMO_ONLY = {
    spline: 'In the editor this adds a road spline to draw along a street. The demo uses a level that already has its points.',
    estimate: 'In the editor this estimates how many points the splines will give. The DTW level has 803.',
    clear: 'In the editor this removes the generated points. The demo keeps its one point.',
    generate: 'In the editor this lays points along every road spline. The demo uses one of them, 000742.',
    anchors: 'In the editor this writes the point positions to a file.',
  };

  // ---------- state ----------
  const DEFAULTS = {
    envName: 'DTW_Day_Clear', startIndex: 1, rootPath: 'D:/datasets',
    tod: 'day', weather: 'none', stereo: 'Stereo', count: 'single',
    modes: { color: true, depth: true, normal: true, semantic: true },
  };
  let staged, applied, target, verifiedKey, captured, capturing, visited;
  let vpMode = 'scene', channel = 'color', view = 'sphere';

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const keyOf = () => JSON.stringify([applied, target]);
  const isDirty = () => JSON.stringify(staged) !== JSON.stringify(applied);

  // ---------- images and pixel data ----------
  const pixels = {};
  let viewer;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load ' + src.slice(0, 40)));
      img.src = src;
    });
  }

  function readPixels(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data };
  }

  async function loadAll() {
    const keys = Object.keys(PANO);
    const imgs = await Promise.all(keys.map((k) => loadImage(PANO[k])));
    keys.forEach((k, i) => {
      if (k !== 'depth_data') viewer.addTexture(k, imgs[i], k === 'semantic');
      if (k === 'depth_data' || k === 'semantic' || k === 'normal' || k.startsWith('color_')) pixels[k] = readPixels(imgs[i]);
    });
  }

  function sample(key, u, v) {
    const p = pixels[key];
    const x = Math.min(p.w - 1, Math.floor(u * p.w)), y = Math.min(p.h - 1, Math.floor(v * p.h));
    const i = (y * p.w + x) * 4;
    return [p.d[i], p.d[i + 1], p.d[i + 2]];
  }

  function semanticShares() {
    const p = pixels.semantic, counts = new Map();
    for (let i = 0; i < p.d.length; i += 4) {
      const k = (p.d[i] << 16) | (p.d[i + 1] << 8) | p.d[i + 2];
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const total = p.w * p.h;
    return [...counts.entries()].map(([k, n]) => ({ cat: CAT_BY_RGB.get(k), pct: 100 * n / total }))
      .filter((e) => e.cat).sort((a, b) => b.pct - a.pct);
  }

  // ---------- small UI helpers ----------
  function toast(text, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4700);
  }

  function openDialog(title, html) {
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = html;
    $('#dialog').hidden = false;
    $('#dlgClose').focus();
  }
  function closeDialog() { $('#dialog').hidden = true; }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const condLabel = (s) => `${s.tod === 'day' ? 'Day' : 'Night'} / ${WEATHER[s.weather]}`;
  const fmtSize = (b) => b >= 1e6 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1024) + ' KB' : b + ' B';

  function manifestRow(weather) {
    const [head, row] = DATA.manifests[weather].split(/\r?\n/);
    const keys = head.split(','), vals = row.split(',');
    return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  }

  // ---------- Setup & Verify: the plugin's checks, in its own words ----------
  function conditionWords(name) {
    const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_\-]+/).filter(Boolean);
    const tod = { day: 'day', daytime: 'day', night: 'night', nighttime: 'night' };
    const weather = { clear: 'none', sunny: 'none', rain: 'rain', rainy: 'rain', snow: 'snow', snowy: 'snow', fog: 'fog', foggy: 'fog', cloudy: 'cloudy', overcast: 'cloudy' };
    return { tod: words.filter((w) => tod[w]).map((w) => tod[w]), weather: words.filter((w) => weather[w]).map((w) => weather[w]) };
  }

  function runChecks() {
    const out = [];
    if (isDirty()) out.push(['S002', 'Block', 'Settings have unapplied changes', 'You changed a value but did not press Apply Settings. Press Apply Settings, then run Setup & Verify again.']);
    if (!Object.values(applied.modes).some(Boolean)) out.push(['S003', 'Block', 'No image type is selected', 'Color, Depth, Normal and Semantic are all unticked, so a capture would write nothing. Tick at least one on the Capture page and press Apply Settings.']);
    if (!applied.rootPath.trim()) out.push(['S004', 'Block', 'Output folder is not set', 'Choose a folder with Browse Path on the Env page, then press Apply Settings.']);
    if (!target || applied.startIndex > Number(NODE)) out.push(['S007', 'Block', 'No capture point is waiting to be shot', 'Every point is skipped or comes before the Start Index. Press Target All on the Points page, or lower Start Index on the Env page.']);
    const w = conditionWords(applied.envName);
    const wrong = w.tod.some((t) => t !== applied.tod) || w.weather.some((x) => x !== applied.weather);
    if (wrong) out.push(['S012', 'Block', 'Env Name names a different condition', `"${applied.envName}" does not match the applied condition (${condLabel(applied)}), so the images would be filed under the wrong one. Rename the run, for example ${suggestName()}, or apply the condition it names.`]);
    return out;
  }

  function suggestName() { return `DTW_${applied.tod === 'day' ? 'Day' : 'Night'}_${WEATHER_WORD[applied.weather]}`; }

  // ---------- rendering the tool ----------
  function syncFields() {
    $('#envName').value = staged.envName;
    $('#startIndex').value = staged.startIndex;
    $('#rootPath').value = staged.rootPath;
    $('#tod').value = staged.tod;
    $('#weather').value = staged.weather;
    $('#stereo').value = staged.stereo;
    $('#count').value = staged.count;
    $$('[data-mode]').forEach((c) => { c.checked = staged.modes[c.dataset.mode]; });
    $('#modeAll').checked = Object.values(staged.modes).every(Boolean);
    $('#ctTarget').checked = target;
    $('#plTarget').checked = target;
  }

  function refresh() {
    const dirty = isDirty();
    const apply = $('#btnApply');
    apply.textContent = dirty ? 'Apply Settings *' : 'Apply Settings';
    apply.classList.toggle('is-dirty', dirty);
    apply.disabled = !dirty;

    const m = staged.modes;
    const tag = ['color', 'depth', 'normal', 'semantic'].filter((k) => m[k]).map((k) => k[0].toUpperCase()).join('+') || 'none';
    $('#statusLine').textContent = `${condLabel(applied)}   ${target ? 1 : 0}/1 pts   1024 ${staged.stereo.toLowerCase()}   ${tag}`;

    $('#envStateName').textContent = condLabel(applied);
    const pending = staged.weather !== applied.weather || staged.tod !== applied.tod;
    $('#envStateTag').textContent = pending ? `selected: ${condLabel(staged)}, not applied` : 'nominal';
    $('#envStateTag').classList.toggle('warn', pending);

    const mf = manifestRow(applied.weather);
    const [sun, skyl] = [/sun=([\d.]+)@(-?\d+)\/(-?\d+)/.exec(mf.RenderParams), /skyl=([\d.]+)/.exec(mf.RenderParams)];
    $('#details').innerHTML =
      `<div><span>Sun</span><b>${sun[1]}</b><em>elevation ${sun[2]}&deg;, azimuth ${sun[3]}&deg;</em></div>` +
      `<div><span>Sky light</span><b>${skyl[1]}</b><em>multiplier on the lighting standard</em></div>` +
      `<div><span>Fog density</span><b>${FOG_DENSITY[applied.weather]}</b><em>typical for ${WEATHER[applied.weather]}</em></div>` +
      `<p>Read from the level, not from the drop-down lists. Rain, snow and fog dim the plugin\u2019s sun.</p>`;

    $('#nextPlay').textContent = `Next Play: ${target && applied.startIndex <= Number(NODE) ? 1 : 0} of 1 points`;
    $('#localStep').classList.toggle('dim', staged.count !== 'group');
    $('#localStep').title = staged.count === 'group' ? 'Spacing of the nine Group positions' : 'Used by Group (9) only';

    $('#btnPlay').disabled = capturing;
    $('#btnStop').disabled = !capturing;
    $$('[data-vp="output"]')[0].disabled = !captured;
    updateSteps();
  }

  // ---------- stepper ----------
  const STEP_HINT = {
    open: 'The Urban360 button on the editor toolbar opens the Capture Tool. It is already open on the right.',
    env: 'Env: name the run and choose a weather. The level changes only when you press Apply Settings.',
    points: 'Points: in the editor you lay points along roads. Here one point, 000742, is ready; keep its Capture Target ticked.',
    capture: 'Capture: choose Stereo or Mono and the outputs to record.',
    verify: 'Verify: press Apply Settings, then Setup & Verify. It checks the level with the plugin\u2019s problem codes.',
    play: 'Play: press the green Play button on the toolbar to capture.',
  };
  let currentStep = 'env';

  function stepDone(s) {
    switch (s) {
      case 'open': return true;
      case 'env': case 'points': case 'capture': return visited.has(s);
      case 'verify': return verifiedKey === keyOf() && !isDirty();
      case 'play': return !!captured;
    }
    return false;
  }

  function updateSteps() {
    const order = ['open', 'env', 'points', 'capture', 'verify', 'play'];
    const next = order.find((s) => !stepDone(s));
    $$('#stepper li').forEach((li) => {
      const s = li.dataset.step;
      li.classList.toggle('done', stepDone(s));
      li.classList.toggle('current', s === next);
    });
    currentStep = next || 'done';
    $('#stepHint').textContent = next ? STEP_HINT[next]
      : 'Done. Switch channels above the viewport, point at the image to read the stored values, or change the weather and capture again.';
  }

  function goStep(s) {
    if (['env', 'points', 'capture'].includes(s)) showPage(s);
    if (s === 'verify') { flash('#btnApply'); flash('#btnVerify'); }
    if (s === 'play') flash('#btnPlay');
    $('#app').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function flash(sel) {
    const el = $(sel);
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  function showPage(p) {
    $$('.tool-tab').forEach((t) => t.classList.toggle('is-on', t.dataset.page === p));
    $$('.tool-page').forEach((pg) => { pg.hidden = pg.dataset.page !== p; });
    visited.add(p);
    refresh();
  }

  // ---------- viewport ----------
  function textureKey() {
    if (vpMode === 'scene') return 'color_' + applied.weather;
    return channel === 'color' ? 'color_' + captured.weather : channel;
  }

  function updateViewport(animate) {
    const out = vpMode === 'output';
    $$('[data-vp]').forEach((b) => b.classList.toggle('is-on', b.dataset.vp === vpMode));
    $('#chanBar').hidden = !out;
    if (out) {
      $$('[data-chan]').forEach((b) => {
        b.hidden = !captured.modes[b.dataset.chan];
        b.classList.toggle('is-on', b.dataset.chan === channel);
      });
    }
    const fileBtn = $('[data-view="file"]');
    fileBtn.hidden = !out;
    fileBtn.disabled = out && channel !== 'color';
    fileBtn.title = channel === 'color' ? 'The image file as written' : 'Shown for Color';
    if (view === 'file' && (!out || channel !== 'color')) view = 'sphere';
    $$('[data-view]').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));

    const isFile = view === 'file';
    $('#fileView').hidden = !isFile;
    $('#pano').style.visibility = isFile ? 'hidden' : 'visible';
    $('#vpHint').hidden = isFile || view === 'flat';
    if (isFile) {
      $('#fileImg').src = `assets/simulator/pano/color_${captured.weather}_stereo.jpg`;
      $('#fileCap').innerHTML = captured.stereo === 'Mono'
        ? 'Mono writes one panorama, W &times; W/2, from the rig centre. The demo data is stereo, shown here as written.'
        : `${NODE}_pos5_color.exr is one W &times; W image (here 1024 &times; 1024): the left eye on top, the right eye below, each a 2:1 panorama.`;
    } else {
      viewer.setMode(view);
      viewer.show(textureKey(), animate);
    }

    const cond = out ? `${captured.tod === 'day' ? 'Day' : 'Night'} / ${WEATHER[captured.weather]}` : condLabel(applied);
    $('#vpBadge').innerHTML = out
      ? `<b>Output</b> ${CHANNELS[channel]} &middot; ${cond} &middot; ${NODE}`
      : `<b>Scene</b> ${cond} &middot; point ${NODE}`;
    updateLegend();
    $('#readout').textContent = out && !isFile ? 'Point at the image to read the stored value.' : '';
  }

  function updateLegend() {
    const lg = $('#legend');
    if (vpMode !== 'output' || view === 'file') { lg.hidden = true; return; }
    lg.hidden = false;
    if (channel === 'depth') {
      const far = DATA.depthFar, pos = (d) => 100 * Math.log1p(d) / Math.log1p(far);
      const ticks = [1, 5, 20, far].map((d) => `<span style="left:${pos(d)}%">${d === far ? far + '+' : d} m</span>`).join('');
      lg.innerHTML = `<div class="lg-title">Depth: distance along the ray</div><div class="lg-bar" style="background:linear-gradient(90deg,${DATA.depthStops.join(',')})"></div><div class="lg-ticks">${ticks}</div><div class="lg-note">black = sky (no surface; stored as 65504)</div>`;
    } else if (channel === 'semantic') {
      lg.innerHTML = `<div class="lg-title">Semantic categories in this view</div><div class="lg-chips">` +
        semanticShares().map((e) => `<span><i style="background:rgb(${e.cat.c.join(',')})"></i>${e.cat.name} <em>${e.pct < 0.1 ? '<0.1' : e.pct.toFixed(1)}%</em></span>`).join('') + '</div>';
    } else if (channel === 'normal') {
      lg.innerHTML = '<div class="lg-title">Normal: unit surface vector</div><div class="lg-note">shown as RGB = 0.5 &times; (x, y, z) + 0.5 &middot; black = no valid normal (A = 0)</div>';
    } else {
      lg.innerHTML = '<div class="lg-title">Color</div><div class="lg-note">stored as linear EXR; shown in sRGB</div>';
    }
  }

  function onPointer(e) {
    if (vpMode !== 'output' || view === 'file' || !captured) return;
    const r = $('#pano').getBoundingClientRect();
    const hit = viewer.lookup(e.clientX - r.left, e.clientY - r.top);
    if (!hit) { $('#readout').textContent = ''; return; }
    const az = ((hit.u - 0.5) * 360).toFixed(1), el = ((0.5 - hit.v) * 180).toFixed(1);
    let val;
    if (channel === 'depth') {
      const [hi, lo] = sample('depth_data', hit.u, hit.v), cm = hi * 256 + lo;
      val = cm === 65535 ? 'Sky: no surface (stored as 65504)' : cm === 65534 ? 'Depth > 655 m' : `Depth ${(cm / 100).toFixed(2)} m`;
    } else if (channel === 'semantic') {
      const c = sample('semantic', hit.u, hit.v), cat = CAT_BY_RGB.get((c[0] << 16) | (c[1] << 8) | c[2]);
      val = cat ? `${cat.name} (ID ${cat.id})` : `Colour ${c.join(', ')}`;
    } else if (channel === 'normal') {
      const c = sample('normal', hit.u, hit.v);
      val = c[0] + c[1] + c[2] === 0 ? 'No valid normal (A = 0)'
        : 'Normal (' + c.map((x) => (x / 255 * 2 - 1).toFixed(2)).join(', ') + ')';
    } else {
      const c = sample('color_' + captured.weather, hit.u, hit.v);
      val = `sRGB ${c.join(', ')}`;
    }
    $('#readout').textContent = `azimuth ${az}\u00B0, elevation ${el}\u00B0  \u2502  ${val}`;
  }

  // ---------- capture ----------
  let capTimer = null;

  function play() {
    if (capturing) return;
    if (verifiedKey !== keyOf() || isDirty()) {
      toast('Run Setup & Verify first. Besides checking the level, it sets the level up so that Play captures instead of playing.', 'warn');
      flash('#btnVerify');
      return;
    }
    const modes = Object.keys(CHANNELS).filter((k) => applied.modes[k]);
    const steps = ['Waiting for the world and shaders', ...modes.map((k) => `${CHANNELS[k]} pass` + (applied.stereo === 'Stereo' ? ' (left and right eye)' : '')), 'Writing files and manifest'];
    capturing = true;
    $('#capNode').textContent = NODE;
    $('#capSteps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
    $('#capOverlay').hidden = false;
    refresh();
    let i = 0;
    const lis = $$('#capSteps li');
    const tick = () => {
      lis.forEach((li, j) => { li.className = j < i ? 'done' : j === i ? 'now' : ''; });
      $('#capBar').style.width = (100 * i / steps.length) + '%';
      if (i === steps.length) { finish(); return; }
      i += 1;
      capTimer = setTimeout(tick, i === 1 ? 900 : 650);
    };
    tick();
  }

  function finish() {
    capturing = false;
    capTimer = null;
    $('#capOverlay').hidden = true;
    captured = { ...clone(applied), runAt: new Date() };
    vpMode = 'output';
    channel = Object.keys(CHANNELS).find((k) => captured.modes[k]);
    updateViewport(true);
    renderOutputs();
    refresh();
    toast(`Captured 1 point into ${captured.rootPath}/${captured.envName}. The output folder is listed below the simulator.`, 'ok');
  }

  function stop() {
    if (!capturing) return;
    clearTimeout(capTimer);
    capturing = false;
    $('#capOverlay').hidden = true;
    refresh();
    toast(`Stopped. ${NODE} did not finish, so it is left out of the manifest; the run report gives the Start Index to resume from.`, 'warn');
  }

  function renderOutputs() {
    const c = captured, sz = DATA.sizes[c.weather];
    const t = c.runAt, p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
    const files = [[`${NODE}_manifest.csv`, sz['manifest.csv'], 'one row per position: pose, exposure, render settings']]
      .concat(Object.keys(CHANNELS).filter((k) => c.modes[k]).map((k) => [`${NODE}_${FILES[k]}`, sz[FILES[k]], CHANNELS[k]]));
    $('#tree').innerHTML =
      `<li class="dir">${esc(c.rootPath)}/</li><li class="dir l1">${esc(c.envName)}/</li><li class="dir l2">${NODE}/</li>` +
      files.map(([n, s, d]) => `<li class="file l3"><span class="fn">${n}</span><span class="fs">${fmtSize(s)}</span><span class="fd">${d}</span></li>`).join('') +
      `<li class="file l2"><span class="fn">_run_${stamp}.txt</span><span class="fs"></span><span class="fd">run report: machine, time, problem codes</span></li>`;
    $('#treeNote').textContent = (c.count === 'group'
      ? 'Group (9) writes the same files for pos1 to pos9 and nine manifest rows; the demo has pos5, the centre. '
      : '') + (c.stereo === 'Mono' ? 'Mono files hold one panorama instead of two eyes. ' : '') +
      'Sizes are those of the real files of this point.';

    const row = manifestRow(c.weather);
    const NOTES = {
      Filename: 'shared by all files of this position', PosX: 'metres', PosY: 'metres', PosZ: 'metres',
      Qw: 'unit quaternion (Qw \u2265 0)', ExposureEV: 'meter reading; images use a fixed exposure',
      DepthConvention: 'first surface the camera meets', TranslucentElements: 'materials made opaque for the depth pass',
      TranslucentPct: '% of pixels whose first surface is translucent',
    };
    const keys = ['Filename', 'PosX', 'PosY', 'PosZ', 'Qw', 'Qx', 'Qy', 'Qz', 'ExposureEV', 'DepthConvention', 'TranslucentElements', 'TranslucentPct'];
    $('#manifest').innerHTML = '<thead><tr><th>Column</th><th>Value</th><th></th></tr></thead><tbody>' +
      keys.map((k) => `<tr><td>${k}</td><td>${esc(row[k])}</td><td>${NOTES[k] || ''}</td></tr>`).join('') + '</tbody>';
    $('#manifestRaw').textContent = DATA.manifests[c.weather];
    $('#outputs').hidden = false;
  }

  // ---------- wiring ----------
  function stage(el, fn) {
    fn();
    const page = el.closest('.tool-page');
    if (page) visited.add(page.dataset.page);
    refresh();
  }

  function bind() {
    $$('#stepper button').forEach((b) => b.addEventListener('click', () => goStep(b.closest('li').dataset.step)));
    $$('.tool-tab').forEach((t) => t.addEventListener('click', () => showPage(t.dataset.page)));

    $('#envName').addEventListener('input', (e) => stage(e.target, () => { staged.envName = e.target.value; }));
    $('#startIndex').addEventListener('input', (e) => stage(e.target, () => { staged.startIndex = Math.max(1, parseInt(e.target.value, 10) || 1); }));
    $('#rootPath').addEventListener('input', (e) => stage(e.target, () => { staged.rootPath = e.target.value; }));
    $('#tod').addEventListener('change', (e) => stage(e.target, () => { staged.tod = e.target.value; }));
    $('#weather').addEventListener('change', (e) => stage(e.target, () => { staged.weather = e.target.value; }));
    $('#stereo').addEventListener('change', (e) => stage(e.target, () => { staged.stereo = e.target.value; }));
    $('#count').addEventListener('change', (e) => stage(e.target, () => { staged.count = e.target.value; }));
    $$('[data-mode]').forEach((c) => c.addEventListener('change', () => stage(c, () => {
      staged.modes[c.dataset.mode] = c.checked;
      $('#modeAll').checked = Object.values(staged.modes).every(Boolean);
    })));
    $('#modeAll').addEventListener('change', (e) => stage(e.target, () => {
      Object.keys(staged.modes).forEach((k) => { staged.modes[k] = e.target.checked; });
      syncFields();
    }));

    const setTarget = (v) => { target = v; syncFields(); refresh(); };
    $('#ctTarget').addEventListener('change', (e) => setTarget(e.target.checked));
    $('#plTarget').addEventListener('change', (e) => setTarget(e.target.checked));
    $('#btnTargetAll').addEventListener('click', () => { setTarget(true); toast('Capture Target ticked on every point.'); });
    $('#btnSkipAll').addEventListener('click', () => { setTarget(false); toast('Capture Target cleared on every point. A run would capture nothing (S007).', 'warn'); });
    $('#btnPointList').addEventListener('click', (e) => {
      const pl = $('#pointList'); pl.hidden = !pl.hidden;
      e.target.textContent = pl.hidden ? 'Open Point List' : 'Close Point List';
    });
    $$('[data-demo-only]').forEach((b) => b.addEventListener('click', () => toast(DEMO_ONLY[b.dataset.demoOnly])));

    $('#btnBrowse').addEventListener('click', () => toast('In the editor this opens a folder picker. Type a path in Current Path to try it here.'));
    $('#btnRefresh').addEventListener('click', () => { refresh(); toast(`Read from the level: ${condLabel(applied)}. Reading never changes the level.`); });
    $('#btnLevelSky').addEventListener('click', () => openDialog('Level Sky & Lights',
      '<p>The capture hides the level\u2019s own sun, sky light, sky and fog, and lights the scene with the plugin\u2019s lighting standard instead, so different worlds are shot under the same light.</p>' +
      '<p>This window lists those actors. If a level has more of them, such as a second sky dome, they can be added with <b>Pick Actors to Hide</b>. The choice is kept in the project settings, not in the level.</p>'));
    $('#btnDetails').addEventListener('click', (e) => {
      const d = $('#details'); d.hidden = !d.hidden;
      e.target.textContent = d.hidden ? '+ Details' : '\u2212 Details';
      e.target.setAttribute('aria-expanded', String(!d.hidden));
    });
    $('#btnCalib').addEventListener('click', (e) => {
      const n = $('#calibNote'); n.hidden = !n.hidden;
      e.target.textContent = n.hidden ? '+ Calibration' : '\u2212 Calibration';
      e.target.setAttribute('aria-expanded', String(!n.hidden));
    });
    $$('.help').forEach((b) => b.addEventListener('click', () => {
      const [title, lines] = HELP[b.dataset.help];
      openDialog(title, lines.map((l) => `<p>${esc(l)}</p>`).join(''));
    }));

    $('#btnSemantic').addEventListener('click', () => openDialog('Semantic window',
      '<img class="dlg-img" src="assets/simulator/editor/semantic_window.png" alt="The Semantic window of the plugin with the Road group of DTW">' +
      '<ol><li>Select actors in the level, or from the list that <b>Open Outliner</b> shows.</li>' +
      '<li>Choose a category in the drop-down list and press <b>Add to Group</b>. Each category becomes a group with its colour, ID and actors.</li>' +
      '<li><b>Find</b> selects an actor in the level; <b>Delete</b> takes it out of the group. <b>Clean Selected</b> and <b>Clean All</b> remove assignments in bulk.</li>' +
      '<li><b>Custom Categories</b> edits the category table. Tick Semantic under Capture Mode to record it.</li></ol>' +
      '<p class="dlg-note">Label rules for meshes and landscape layers are set in Project Settings &gt; Plugins &gt; Urban360 &gt; Semantic. The demo point is already labelled.</p>'));
    $('#btnExr').addEventListener('click', () => {
      if (!captured) { toast('Nothing captured yet. Press Play first.'); return; }
      vpMode = 'output'; updateViewport(true);
      toast('The output is open in the viewport. In the editor the EXR Viewer opens the files of a capture.');
    });

    $('#btnApply').addEventListener('click', () => {
      const weatherChanged = staged.weather !== applied.weather;
      applied = clone(staged);
      verifiedKey = null;
      if (vpMode === 'scene') updateViewport(weatherChanged);
      refresh();
      toast(weatherChanged ? `Applied. The level is now ${condLabel(applied)}.` : 'Settings applied.');
    });

    $('#btnVerify').addEventListener('click', () => {
      const problems = runChecks();
      if (!problems.length) {
        verifiedKey = keyOf();
        const b = $('#btnVerify');
        b.classList.add('ok'); b.textContent = 'Verified';
        setTimeout(() => { b.classList.remove('ok'); b.innerHTML = 'Setup &amp; Verify'; }, 2000);
        refresh();
        return;
      }
      verifiedKey = null;
      refresh();
      openDialog('Setup & Verify', '<p>Fix these and run Setup &amp; Verify again.</p><ul class="problems">' +
        problems.map(([code, sev, title, what]) => `<li><span class="code">${code}</span><span class="sev">${sev}</span><b>${esc(title)}</b><p>${esc(what)}</p></li>`).join('') + '</ul>');
    });

    $('#btnPlay').addEventListener('click', play);
    $('#btnStop').addEventListener('click', stop);
    $('#btnReset').addEventListener('click', reset);

    $$('[data-vp]').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) { vpMode = b.dataset.vp; updateViewport(true); } }));
    $$('[data-chan]').forEach((b) => b.addEventListener('click', () => { channel = b.dataset.chan; updateViewport(true); }));
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) { view = b.dataset.view; updateViewport(false); } }));

    $('#pano').addEventListener('pointermove', onPointer);
    $('#pano').addEventListener('pointerleave', () => { if (vpMode === 'output') $('#readout').textContent = ''; });
    $('#dlgClose').addEventListener('click', closeDialog);
    $('#dialog').addEventListener('click', (e) => { if (e.target.id === 'dialog') closeDialog(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#dialog').hidden) closeDialog(); });
  }

  function reset() {
    if (capTimer) clearTimeout(capTimer);
    staged = clone(DEFAULTS); applied = clone(DEFAULTS);
    target = true; verifiedKey = null; captured = null; capturing = false;
    visited = new Set();
    vpMode = 'scene'; channel = 'color'; view = 'sphere';
    $('#capOverlay').hidden = true;
    $('#outputs').hidden = true;
    closeDialog();
    syncFields();
    showPage('env');
    visited = new Set(); // the Env page is open at start, but the step counts once the user uses it
    refresh();
    if (viewer) { viewer.resetView(); viewer.autoRotate = true; updateViewport(false); }
  }

  async function init() {
    reset();
    bind();
    try {
      viewer = new window.PanoViewer($('#pano'));
      await loadAll();
      $('#loading').hidden = true;
      updateViewport(false);
    } catch (err) {
      $('#loading').textContent = 'The viewer could not start: ' + err.message;
    }
  }

  init();
})();
