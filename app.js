/* ============================================================
   Dice Tray — application logic
   Wires DICE.js + DieBuilder into the two-panel UI.
   ============================================================ */
(function () {
  'use strict';

  /* ==========================================================
     HELPERS
     ========================================================== */
  var $  = function (s, r) { return (r || document).querySelector(s); };

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function fmtNum(v, step) {
    if (typeof v !== 'number' || !isFinite(v)) return String(v == null ? '' : v);
    if (step >= 1) return String(Math.round(v));
    return String(parseFloat(v.toFixed(2)));
  }

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ==========================================================
     ELEMENT REFS
     ========================================================== */
  var el = {
    stage:        $('#stage'),
    tray:         $('#diceRoller'),
    input:        $('#textInput'),
    rollBtn:      $('#rollBtn'),
    rollLabel:    $('#rollBtnLabel'),
    chips:        $('#presetChips'),
    hud:          $('#hud'),
    hudNotation:  $('#hudNotation'),
    customHead:   $('#customHead'),
    customCard:   $('#customCard'),
    customGroups: $('#customGroups'),
    toastWrap:    $('#toastWrap'),

    scrim:        $('#scrim'),
    modal:        $('#modal'),
    aura:         $('#modalAura'),
    total:        $('#modalTotal'),
    caption:      $('#modalCaption'),
    badge:        $('#modalBadge'),
    notation:     $('#modalNotation'),
    dice:         $('#modalDice'),
    stats:        $('#modalStats'),
    auditWrap:    $('#modalAuditWrap'),
    audit:        $('#modalAudit'),
    btnClose:     $('#modalClose'),
    btnDismiss:   $('#modalDismiss'),
    btnAgain:     $('#modalAgain')
  };

  /* ==========================================================
     STATE
     ========================================================== */
  var box = null;          // DICE.dice_box
  var builder = null;      // DieBuilder
  var rolling = false;
  var boxReady = false;
  var lastNotation = '1d20';
  var toastTimer = null;

  /* ==========================================================
     PARAMETER SCHEMA
     Fallbacks only — live metadata from dice.js wins.
     ========================================================== */
  var PARAM_GROUPS = [
    {
      title: 'Appearance',
      params: [
        { key: 'desk_color',               label: 'Table colour',     fallback: { type: 'color',  def: '#101010' } },
        { key: 'desk_opacity',             label: 'Table opacity',    fallback: { type: 'number', min: 0, max: 1, step: 0.01, def: 0.5 } },
        { key: 'use_shadows',              label: 'Shadows',          fallback: { type: 'boolean', def: true } },
        { key: 'ambient_light_color',      label: 'Ambient light',    fallback: { type: 'color',  def: '#f0f0f0' } },
        { key: 'spot_light_color',         label: 'Spot light',       fallback: { type: 'color',  def: '#efefef' } },
        { key: 'spot_light_intensity',     label: 'Spot intensity',   fallback: { type: 'number', min: 0, max: 10, step: 0.1, def: 2 } },
        { key: 'camera_fov',               label: 'Camera FOV',       fallback: { type: 'number', min: 5, max: 90, step: 1, def: 20 }, unit: '°' },
        { key: 'dice_color',               label: 'Dice body',        fallback: { type: 'color',  def: '#202020' } },
        { key: 'label_color',              label: 'Dice numerals',    fallback: { type: 'color',  def: '#aaaaaa' } },
        { key: 'dropped_dice_color',       label: 'Dropped body',     fallback: { type: 'color',  def: '#4d4d4d' } },
        { key: 'dropped_dice_label_color', label: 'Dropped numerals', fallback: { type: 'color',  def: '#1a1a1a' } }
      ]
    },
    {
      title: 'Physics',
      params: [
        { key: 'gravity_z',             label: 'Gravity (down)',      fallback: { type: 'number',  min: -10000, max: 10000, step: 50, def: 7840 } },
        { key: 'gravity_x',             label: 'Gravity X',           fallback: { type: 'number',  min: -10000, max: 10000, step: 50, def: 0 } },
        { key: 'gravity_y',             label: 'Gravity Y',           fallback: { type: 'number',  min: -10000, max: 10000, step: 50, def: 0 } },
        { key: 'solver_iterations',     label: 'Solver iterations',   fallback: { type: 'integer', min: 1, max: 100, step: 1, def: 16 } },
        { key: 'dice_friction',         label: 'Dice friction',       fallback: { type: 'number',  min: 0, max: 1, step: 0.01, def: 0.01 } },
        { key: 'dice_restitution',      label: 'Dice bounce',         fallback: { type: 'number',  min: 0, max: 1, step: 0.01, def: 0.5 } },
        { key: 'dice_dice_friction',    label: 'Die-on-die friction', fallback: { type: 'number',  min: 0, max: 1, step: 0.01, def: 0 } },
        { key: 'dice_dice_restitution', label: 'Die-on-die bounce',   fallback: { type: 'number',  min: 0, max: 1, step: 0.01, def: 0.5 } },
        { key: 'linear_damping',        label: 'Linear damping',      fallback: { type: 'number',  min: 0, max: 1, step: 0.01, def: 0.1 } },
        { key: 'angular_damping',       label: 'Angular damping',     fallback: { type: 'number',  min: 0, max: 1, step: 0.01, def: 0.1 } }
      ]
    },
    {
      title: 'Dice size',
      params: [
        { key: 'size_multiplier',           label: 'Size multiplier', fallback: { type: 'number',  min: 0.1, max: 3, step: 0.05, def: 1 } },
        { key: 'auto_scale_enabled',        label: 'Auto-scale',      fallback: { type: 'boolean', def: true } },
        { key: 'auto_scale_baseline_dice',  label: 'Baseline count',  fallback: { type: 'integer', min: 1, max: 50, step: 1, def: 6 } },
        { key: 'auto_scale_exponent',       label: 'Scale curve',     fallback: { type: 'number',  min: 0, max: 1.5, step: 0.05, def: 0.5 } },
        { key: 'auto_scale_min_factor',     label: 'Minimum scale',   fallback: { type: 'number',  min: 0.05, max: 1, step: 0.01, def: 0.35 } }
      ]
    },
    {
      title: 'Behaviour',
      params: [
        { key: 'd100_compound',       label: 'Compound d100',       fallback: { type: 'boolean', def: true } },
        { key: 'max_recursion_depth', label: 'Max explosion depth', fallback: { type: 'integer', min: 1, max: 50, step: 1, def: 10 } },
        { key: 'max_dice_per_roll',   label: 'Max dice per roll',   fallback: { type: 'integer', min: 1, max: 500, step: 1, def: 100 } },
        { key: 'explosion_delay_ms',  label: 'Explosion delay',     fallback: { type: 'integer', min: 0, max: 1500, step: 50, def: 300 }, unit: 'ms' }
      ]
    },
    {
      title: 'Fade & timing',
      params: [
        { key: 'fade_enabled',     label: 'Fade dice out', fallback: { type: 'boolean', def: true } },
        { key: 'fade_delay_ms',    label: 'Fade delay',    fallback: { type: 'integer', min: 0, max: 60000, step: 250, def: 3000 }, unit: 'ms' },
        { key: 'fade_duration_ms', label: 'Fade duration', fallback: { type: 'integer', min: 0, max: 10000, step: 100, def: 800 }, unit: 'ms' },
        { key: 'roll_timeout_ms',  label: 'Roll timeout',  fallback: { type: 'integer', min: 0, max: 120000, step: 1000, def: 20000 }, unit: 'ms' }
      ]
    },
    {
      title: 'Reproducibility',
      params: [
        { key: 'rng_seed', label: 'RNG seed', special: 'seed', fallback: { type: 'integer', min: 0, max: 2147483647, step: 1, def: null } }
      ]
    }
  ];

  /* ==========================================================
     DICE BOX
     ========================================================== */
  function whenSized(node, cb) {
    if (node.clientWidth > 0 && node.clientHeight > 0) return cb();
    if (typeof ResizeObserver === 'undefined') {
      return window.setTimeout(function () { whenSized(node, cb); }, 60);
    }
    var ro = new ResizeObserver(function () {
      if (node.clientWidth > 0 && node.clientHeight > 0) {
        ro.disconnect();
        cb();
      }
    });
    ro.observe(node);
  }

  function initDiceBox() {
    if (!window.DICE || typeof window.DICE.dice_box !== 'function') {
      toast('DICE.js failed to load. Check the libs/ paths.');
      return;
    }

    try {
      box = new DICE.dice_box(el.tray);
    } catch (err) {
      toast('Could not create the dice tray: ' + (err && err.message ? err.message : err));
      return;
    }

    safeSetConfig({ desk_opacity: 0.35 });

    boxReady = true;
    el.rollBtn.disabled = false;

    try {
      if (typeof box.bind_swipe === 'function') {
        box.bind_swipe(el.stage, null, function (result) {
          handleRollResult(result);
        });
      }
    } catch (e) { /* swipe is a nicety */ }

    try {
      if (typeof box.setOnExplosion === 'function') {
        box.setOnExplosion(function () { flashStage(); });
      }
    } catch (e) {}

    buildCustomisation();
  }

  function safeSetParam(key, value) {
    if (!box || typeof box.setParam !== 'function') return false;
    try {
      box.setParam(key, value);
      return true;
    } catch (err) {
      console.warn('[Dice Tray] setParam("' + key + '") rejected:', err && err.message ? err.message : err);
      return false;
    }
  }

  function safeSetConfig(cfg) {
    if (!box) return;
    if (typeof box.setConfig === 'function') {
      try { box.setConfig(cfg); return; } catch (e) {}
    }
    Object.keys(cfg).forEach(function (k) { safeSetParam(k, cfg[k]); });
  }

  /* ==========================================================
     CUSTOMISATION PANEL
     ========================================================== */
  function describeParam(def) {
    var fb = def.fallback || {};
    var live = null;

    if (box && typeof box.getParamInfo === 'function') {
      try {
        var info = box.getParamInfo(def.key);
        if (info && typeof info === 'object') live = info;
      } catch (e) { live = null; }
    }

    var rawType = (live && live.type) || fb.type || 'number';
    var type = (rawType === 'integer') ? 'number' : rawType;
    var isInt = (rawType === 'integer') || fb.type === 'integer';

    var value = (live && live.current !== undefined) ? live.current
              : (fb.def !== undefined ? fb.def : '');

    var min = (live && typeof live.min === 'number') ? live.min : fb.min;
    var max = (live && typeof live.max === 'number') ? live.max : fb.max;
    var step;

    if (type === 'number') {
      if (typeof min !== 'number') min = 0;
      if (typeof max !== 'number') max = 100;
      step = isInt ? 1
           : ((typeof fb.step === 'number' && fb.step > 0) ? fb.step : 0.01);

      var v = Number(value);
      if (isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    return { type: type, value: value, min: min, max: max, step: step };
  }

  function buildCustomisation() {
    el.customGroups.innerHTML = '';

    PARAM_GROUPS.forEach(function (group) {
      var section = document.createElement('section');
      section.className = 'acc';

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'acc__head';
      head.setAttribute('aria-expanded', 'false');
      head.innerHTML =
        '<span>' + esc(group.title) + '</span>' +
        '<svg class="acc__chev" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

      var body = document.createElement('div');
      body.className = 'acc__body';
      var inner = document.createElement('div');
      inner.className = 'acc__inner';
      var pad = document.createElement('div');
      pad.className = 'acc__pad';

      group.params.forEach(function (def) {
        pad.appendChild(renderControl(def));
      });

      inner.appendChild(pad);
      body.appendChild(inner);
      section.appendChild(head);
      section.appendChild(body);

      head.addEventListener('click', function () {
        var open = section.classList.toggle('is-open');
        head.setAttribute('aria-expanded', String(open));
      });

      el.customGroups.appendChild(section);
    });
  }

  function renderControl(def) {
    var info = describeParam(def);
    var row = document.createElement('div');
    row.className = 'ctrl ctrl--' + info.type;

    /* ---------- seed ---------- */
    if (def.special === 'seed') {
      var isSet = typeof info.value === 'number' && isFinite(info.value);
      row.innerHTML =
        '<div class="ctrl__top">' +
          '<span class="ctrl__label">' + esc(def.label) + '</span>' +
          '<span class="ctrl__val" data-seed-state>' + (isSet ? esc(info.value) : 'random') + '</span>' +
        '</div>' +
        '<div class="seed-row">' +
          '<input class="text-input" type="number" min="0" max="2147483647" step="1" ' +
            'placeholder="random" value="' + (isSet ? esc(info.value) : '') + '" ' +
            'aria-label="RNG seed" />' +
          '<button class="mini-btn" type="button" data-seed-random>Random</button>' +
        '</div>';

      var seedInput = row.querySelector('input');
      var seedState = row.querySelector('[data-seed-state]');

      function commitSeed(raw) {
        if (raw === '' || raw === null) {
          safeSetParam(def.key, null);
          seedState.textContent = 'random';
          return;
        }
        var n = parseInt(raw, 10);
        if (!isFinite(n)) return;
        n = clamp(n, 0, 2147483647);
        if (safeSetParam(def.key, n)) seedState.textContent = String(n);
      }

      seedInput.addEventListener('change', function () { commitSeed(seedInput.value); });
      row.querySelector('[data-seed-random]').addEventListener('click', function () {
        var n = Math.floor(Math.random() * 2147483647);
        seedInput.value = String(n);
        commitSeed(n);
      });

      return row;
    }

    /* ---------- boolean ---------- */
    if (info.type === 'boolean') {
      row.innerHTML =
        '<div class="ctrl__top">' +
          '<span class="ctrl__label">' + esc(def.label) + '</span>' +
          '<label class="switch">' +
            '<input type="checkbox" ' + (info.value ? 'checked' : '') +
              ' aria-label="' + esc(def.label) + '">' +
            '<span class="switch__track"><span class="switch__thumb"></span></span>' +
          '</label>' +
        '</div>';

      var cb = row.querySelector('input');
      cb.addEventListener('change', function () {
        safeSetParam(def.key, cb.checked);
      });
      return row;
    }

    /* ---------- colour ---------- */
    if (info.type === 'color') {
      var colorVal = normaliseHex(info.value);
      row.innerHTML =
        '<div class="ctrl__top">' +
          '<span class="ctrl__label">' + esc(def.label) + '</span>' +
          '<span class="ctrl__val" data-out>' + esc(colorVal) + '</span>' +
        '</div>' +
        '<input type="color" value="' + esc(colorVal) + '" aria-label="' + esc(def.label) + '">';

      var colorInput = row.querySelector('input');
      var colorOut = row.querySelector('[data-out]');

      var commitColor = debounce(function (hex) {
        colorOut.textContent = hex;
        safeSetParam(def.key, hex);
      }, 80);

      colorInput.addEventListener('input', function () {
        colorOut.textContent = colorInput.value;
        commitColor(colorInput.value);
      });
      return row;
    }

    /* ---------- number / integer ---------- */
    var numVal = Number(info.value);
    if (!isFinite(numVal)) numVal = info.min;

    row.innerHTML =
      '<div class="ctrl__top">' +
        '<span class="ctrl__label">' + esc(def.label) + '</span>' +
        '<span class="ctrl__val" data-out>' +
          fmtNum(numVal, info.step) + (def.unit ? ' ' + esc(def.unit) : '') +
        '</span>' +
      '</div>' +
      '<input type="range" min="' + info.min + '" max="' + info.max + '" ' +
        'step="' + info.step + '" value="' + numVal + '" ' +
        'aria-label="' + esc(def.label) + '">';

    var range = row.querySelector('input');
    var out = row.querySelector('[data-out]');

    var commitNum = debounce(function (n) {
      safeSetParam(def.key, n);
    }, 60);

    range.addEventListener('input', function () {
      var n = parseFloat(range.value);
      out.textContent = fmtNum(n, info.step) + (def.unit ? ' ' + def.unit : '');
      commitNum(n);
    });

    return row;
  }

  function normaliseHex(v) {
    var s = String(v == null ? '#000000' : v).trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) {
      return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    }
    var m = /^(?:0x)?([0-9a-f]{6})$/i.exec(s.replace('#', ''));
    if (m) return '#' + m[1].toLowerCase();
    return '#000000';
  }

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  /* ==========================================================
     DIE BUILDER
     ========================================================== */
  function initBuilder() {
    if (typeof window.DieBuilder !== 'function') {
      console.warn('[Dice Tray] DieBuilder not found — manual notation still works.');
      return;
    }

    try {
      builder = new DieBuilder({
        theme: {
          mode: 'dark',
          colors: {
            primary:      '#e0b25f',
            primaryHover: '#f3d194',
            primaryRing:  'rgba(224,178,95,0.18)',
            background:   '#12161d',
            surface:      '#171c25',
            surfaceHover: '#1d232e',
            text:         '#e9ecf2',
            textMuted:    '#8b93a6',
            textSubtle:   '#5c6478',
            border:       'rgba(255,255,255,0.10)',
            borderHover:  'rgba(224,178,95,0.34)',
            borderSubtle: 'rgba(255,255,255,0.06)',
            inputBg:      '#0a0d13',
            success:      '#4ade80',
            danger:       '#f87171',
            warning:      '#fbbf24'
          }
        },
        labels: {
          title: 'Dice Notation Builder',
          accept: 'Use this roll'
        },
        callbacks: {
          onAccept: function (notation) {
            if (!notation) return;
            lastNotation = notation;
            syncHud();
          },
          onChange: function (notation) {
            if (notation) {
              lastNotation = notation;
              syncHud();
            }
          }
        }
      });

      builder.attachTo('#textInput', {
        popup: {
          trigger: 'button',
          width: '520px',
          maxHeight: '74vh',
          closeOnOutsideClick: true,
          closeOnEscape: true
        }
      });
    } catch (err) {
      console.warn('[Dice Tray] DieBuilder init failed:', err);
    }
  }

  /* ==========================================================
     ROLLING
     ========================================================== */
  function currentNotation() {
    var v = (el.input.value || '').trim();
    return v || '1d20';
  }

  function syncHud() {
    el.hudNotation.textContent = currentNotation();
  }

  function setRolling(on) {
    rolling = on;
    el.rollBtn.classList.toggle('is-rolling', on);
    el.rollBtn.disabled = on || !boxReady;
    el.rollLabel.textContent = on ? 'Rolling…' : 'Roll the dice';
    el.hud.classList.toggle('is-rolling', on);
  }

  function flashStage() {
    if (reduceMotion) return;
    el.stage.animate(
      [
        { filter: 'brightness(1)' },
        { filter: 'brightness(1.28)' },
        { filter: 'brightness(1)' }
      ],
      { duration: 260, easing: 'ease-out' }
    );
  }

  function doRoll() {
    if (!boxReady || rolling || !box) return;

    var notation = currentNotation();

    if (builder && typeof builder.validateNotation === 'function') {
      try {
        var check = builder.validateNotation(notation);
        if (check && check.valid === false) {
          var msg = (check.errors && check.errors[0] && check.errors[0].message) || 'Invalid notation.';
          toast(msg);
          return;
        }
      } catch (e) { /* fall through */ }
    }

    lastNotation = notation;
    syncHud();
    closeModal(true);
    setRolling(true);

    try {
      box.setDice(notation);
    } catch (err) {
      setRolling(false);
      toast('Could not parse that notation.');
      return;
    }

    var promise;
    try {
      promise = box.roll();
    } catch (err) {
      setRolling(false);
      toast(errMsg(err));
      return;
    }

    if (!promise || typeof promise.then !== 'function') {
      setRolling(false);
      return;
    }

    promise.then(function (result) {
      setRolling(false);
      handleRollResult(result);
    }, function (err) {
      setRolling(false);
      if (err && err.code === 'ROLL_IN_PROGRESS') return;
      toast(errMsg(err));
    });
  }

  function errMsg(err) {
    if (!err) return 'The roll failed.';
    return err.userMessage || err.message || String(err);
  }

  function handleRollResult(result) {
    if (!result) return;
    if (result.error) {
      toast(result.errorMessage || 'The roll could not be resolved.');
      return;
    }
    showResult(result);
  }

  /* ==========================================================
     RESULT NORMALISATION
     ========================================================== */
  function normaliseDice(result) {
    var src = Array.isArray(result.diceResults) ? result.diceResults : [];
    var out = [];

    if (src.length) {
      src.forEach(function (d) {
        if (!d || typeof d !== 'object') return;
        var value = pick(d, ['value', 'result', 'face', 'faceValue', 'number', 'rolled', 'total']);
        if (value === undefined) return;

        var dropped = !!pick(d, ['dropped', 'isDropped', 'is_dropped', 'discarded']);
        if (!dropped && d.kept === false) dropped = true;

        out.push({
          value: value,
          dropped: dropped,
          critical: !!pick(d, ['critical', 'isCritical', 'is_critical', 'crit']),
          success:  !!pick(d, ['success',  'isSuccess',  'is_success']),
          failure: !!pick(d, ['criticalFailure', 'isCriticalFailure', 'is_critical_failure', 'failure', 'isFailure'])
        });
      });
    }

    if (!out.length && Array.isArray(result.result)) {
      out = result.result.map(function (v) {
        return { value: v, dropped: false, critical: false, failure: false };
      });
    }

    return out;
  }

  /* ==========================================================
     MODAL
     ========================================================== */
  var modalOpen = false;
  var closeTimer = null;

  function openModal() {
    clearTimeout(closeTimer);
    el.scrim.hidden = false;
    modalOpen = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.scrim.classList.add('is-open'); });
    });
    document.addEventListener('keydown', onModalKey);
    setTimeout(function () { el.btnAgain.focus({ preventScroll: true }); }, 380);
  }

  function closeModal(immediate) {
    if (!modalOpen) { el.scrim.hidden = true; return; }
    modalOpen = false;
    el.scrim.classList.remove('is-open');
    document.removeEventListener('keydown', onModalKey);

    if (immediate || reduceMotion) {
      el.scrim.hidden = true;
    } else {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(function () { el.scrim.hidden = true; }, 320);
    }
  }

  function onModalKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
  }

  function showResult(result) {
    var dice      = normaliseDice(result);
    var total     = Number(result.resultTotal);
    var constant  = Number(result.constant) || 0;
    var kept = dice.filter(function (d) { return !d.dropped; });  
    var critSucc = kept.filter(function (d) { return d.critical && d.success; });
    var critFail = kept.filter(function (d) { return d.critical && d.failure; });
    var plainSucc = kept.filter(function (d) { return d.success && !d.critical; });
    var plainFail = kept.filter(function (d) { return d.failure && !d.critical; });

    el.notation.textContent = lastNotation;

    var hasCritSucc = critSucc.length > 0;
    var hasCritFail = critFail.length > 0;

    el.total.classList.toggle('is-crit', hasCritSucc && !hasCritFail);
    el.total.classList.toggle('is-fail', hasCritFail && !hasCritSucc);
    el.aura.classList.toggle('is-crit', hasCritSucc && !hasCritFail);
    el.aura.classList.toggle('is-fail', hasCritFail && !hasCritSucc);

    if (hasCritSucc) {
        el.badge.hidden = false;
        el.badge.className = 'hero__badge is-crit';
        el.badge.textContent = critSucc.length > 1
            ? critSucc.length + ' Critical Successes'
            : 'Critical Success';
    } else if (hasCritFail) {
        el.badge.hidden = false;
        el.badge.className = 'hero__badge is-fail';
        el.badge.textContent = critFail.length > 1
            ? critFail.length + ' Critical Failures'
            : 'Critical Failure';
    } else {
        el.badge.hidden = true;
    }

    if (isFinite(total)) {
      animateNumber(el.total, total);
    } else {
      el.total.textContent = String(result.resultTotal);
    }

    el.dice.innerHTML = dice.map(function (d, i) {
    var cls = 'die-chip';
    if (d.dropped)                     cls += ' is-dropped';
    else if (d.critical && d.failure)  cls += ' is-fail';
    else if (d.critical && d.success)  cls += ' is-crit';
    else if (d.failure)                cls += ' is-failure';
    else if (d.success)                cls += ' is-success';

      var delay = reduceMotion ? 0 : Math.min(i * 26, 520);
      var title = d.dropped ? 'Dropped' : (d.critical ? 'Critical' : (d.failure ? 'Failure' : 'Kept'));

      return '<span class="' + cls + '" style="animation-delay:' + delay + 'ms" title="' + esc(title) + '">' +
               esc(d.value) +
             '</span>';
    }).join('');

    var stats = [];
    stats.push({ k: 'Total', v: isFinite(total) ? total : String(result.resultTotal), gold: true });
    if (dice.length) stats.push({ k: 'Dice rolled', v: dice.length });
    stats.push({ k: 'Kept', v: kept.length });
    if (dropped.length) stats.push({ k: 'Dropped', v: dropped.length });
    if (constant)      stats.push({ k: 'Modifier', v: (constant > 0 ? '+' : '') + constant, gold: true });
    if (critSucc.length)  stats.push({ k: 'Critical Hits',   v: critSucc.length,  good: true });
    if (critFail.length)  stats.push({ k: 'Critical Misses', v: critFail.length,  bad:  true });
    if (plainSucc.length) stats.push({ k: 'Successes',       v: plainSucc.length, good: true });
    if (plainFail.length) stats.push({ k: 'Failures',        v: plainFail.length, bad:  true });

    var phases = countPhases(result);
    if (phases > 1) stats.push({ k: 'Phases', v: phases });

    el.stats.innerHTML = stats.map(function (s) {
      var cls = 'stat';
      if (s.good) cls += ' is-good';
      if (s.bad)  cls += ' is-bad';
      if (s.gold) cls += ' is-gold';
      return '<div class="' + cls + '">' +
               '<p class="stat__k">' + esc(s.k) + '</p>' +
               '<p class="stat__v' + (typeof s.v === 'string' ? ' mono' : '') + '">' + esc(s.v) + '</p>' +
             '</div>';
    }).join('');

    el.audit.innerHTML = renderAudit(result);
    el.auditWrap.open = false;

    openModal();
  }

  function countPhases(result) {
    if (!Array.isArray(result.audit)) return 1;
    var max = 0;
    result.audit.forEach(function (a) {
      var p = Number(a && a.phase);
      if (isFinite(p) && p > max) max = p;
    });
    return max + 1;
  }

  function renderAudit(result) {
    var list = Array.isArray(result.audit) ? result.audit : null;
    var lines = [];

    if (list && list.length) {
      list.forEach(function (a, i) {
        var n = (a && a.step !== undefined) ? a.step : i;
        var text = (a && (a.description || a.type)) || '';
        lines.push(
          '<li><span class="n">' + esc(n) + '</span><span>' + esc(text) + '</span></li>'
        );
      });
    } else if (result.auditString) {
      String(result.auditString).split('\n').forEach(function (line, i) {
        if (!line.trim()) return;
        lines.push('<li><span class="n">' + i + '</span><span>' + esc(line) + '</span></li>');
      });
    }

    if (!lines.length) {
      lines.push('<li><span>No audit information was recorded for this roll.</span></li>');
    }
    return lines.join('');
  }

  function animateNumber(node, target) {
    if (reduceMotion || !isFinite(target)) {
      node.textContent = String(target);
      return;
    }
    var duration = 720;
    var start = performance.now();

    node.textContent = '0';

    function frame(now) {
      var p = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = String(Math.round(target * eased));
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        node.textContent = String(target);
      }
    }
    requestAnimationFrame(frame);
  }

  /* ==========================================================
     TOAST
     ========================================================== */
  function toast(message) {
    var node = document.createElement('div');
    node.className = 'toast';
    node.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
      '<span>' + esc(message) + '</span>';

    el.toastWrap.appendChild(node);

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.add('is-out');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 280);
    }, 4200);
  }

  /* ==========================================================
     WIRING
     ========================================================== */
  function wire() {
    el.rollBtn.addEventListener('click', doRoll);

    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doRoll(); }
    });

    el.input.addEventListener('input', syncHud);

    el.chips.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      var notation = chip.getAttribute('data-notation');
      if (!notation) return;
      el.input.value = notation;
      el.input.dispatchEvent(new Event('input', { bubbles: true }));
      el.input.dispatchEvent(new Event('change', { bubbles: true }));
      if (boxReady && !rolling) doRoll();
    });

    el.customHead.addEventListener('click', function () {
      var open = el.customCard.classList.toggle('is-open');
      el.customHead.setAttribute('aria-expanded', String(open));
    });

    el.btnClose.addEventListener('click', function () { closeModal(); });
    el.btnDismiss.addEventListener('click', function () { closeModal(); });
    el.btnAgain.addEventListener('click', function () {
      closeModal();
      setTimeout(doRoll, reduceMotion ? 0 : 260);
    });

    el.scrim.addEventListener('mousedown', function (e) {
      if (e.target === el.scrim) closeModal();
    });

    syncHud();
  }

  /* ==========================================================
     BOOT
     ========================================================== */
  function boot() {
    wire();
    initBuilder();

    requestAnimationFrame(function () {
      whenSized(el.tray, initDiceBox);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();