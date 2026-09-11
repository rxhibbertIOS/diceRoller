// @ts-check
/**
 * @fileoverview DieBuilder — a dependency-free, embeddable UI for building
 * and validating RPG dice notation strings (e.g. `4d6dl1`, `2d20kh1!>15`).
 *
 * Two presentation modes:
 *
 * 1. **Standalone** — render into a container with {@link DieBuilder#inject}.
 * 2. **Popup** — attach to an existing `<input>` with
 *    {@link DieBuilder#attachTo}; a dialog opens on focus or on a floating
 *    trigger button.
 *
 * The builder produces notation strings that are compatible with the DICE.js
 * roller (`DICE.parse_notation`). It does not roll dice itself.
 *
 * @version 1.0.0
 * @author ...
 * @license See LICENSE in the repository.
 */

/**
 * A single rule attachment on a group.
 * @typedef {Object} RuleEntry
 * @property {string} id - Rule identifier; a key of `RULE_DEFS`, or `'none'`.
 * @property {number} [ruleModifier=1] - Amount for rules that need one
 *   (keep/drop count, reroll count, target number, failure count).
 * @property {'='|'>'|'<'} [limitOperator='='] - Comparison operator for rules
 *   with a trigger condition (explode, reroll, criticals).
 * @property {number} [limitValue=1] - Trigger value for rules with a condition.
 */

/**
 * A single dice group: `N` dice of a given type, zero or more rules, and an
 * optional flat bonus.
 * @typedef {Object} Group
 * @property {string|null} id - Internal id (`'g1'`, `'g2'`, …) or `null`
 *   before the group has been committed.
 * @property {number} quantity - Number of dice (1–100).
 * @property {string} dieType - Die type, e.g. `'d6'`, `'d20'`.
 * @property {RuleEntry[]} rules - Ordered rule attachments.
 * @property {number} [bonus=0] - Flat modifier added to the group total.
 */

/**
 * A single validation error.
 * @typedef {Object} ValidationError
 * @property {string} field - One of: `'quantity'`, `'dieType'`,
 *   `'ruleModifier'`, `'limitValue'`, `'notation'`, `'custom'`.
 * @property {string} message - Human-readable description.
 * @property {string} [groupId] - Group the error belongs to.
 * @property {number} [groupIndex] - Index of the group.
 * @property {number} [ruleIndex] - Index of the rule within the group.
 * @property {string} [ruleId] - Rule identifier.
 */

/**
 * Result of {@link DieBuilder#validate} / {@link DieBuilder#validateNotation}.
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - `true` if the state is fully valid.
 * @property {string} notation - Notation the validation was run against.
 * @property {ValidationError[]} errors - Empty when `valid` is `true`.
 */

/**
 * Callback used by several lifecycle hooks.
 * @callback NotationCallback
 * @param {string} notation - Current notation string.
 * @param {Group[]} groups - Current groups array.
 * @param {*} [data] - Event-specific payload (added group, removed group, …).
 * @returns {void}
 */

/**
 * Custom validator hook. Return `true`/`undefined` for valid, a string for a
 * custom error message, or `false` for a generic "invalid notation" error.
 * @callback CustomValidator
 * @param {string} notation - The notation string.
 * @param {Group[]} groups - The parsed groups.
 * @returns {boolean|string|undefined}
 */
(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DieBuilder = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {

  // ============================================================
  // 1. RULES DEFINITION
  // ============================================================
  const RULE_DEFS = {
    keep: {
      id: 'keep', label: 'Keep Highest', category: 'filter',
      needsModifier: true, needsLimit: false,
      modifierMax: 'quantity', modifierMin: 1,
      notation: (g, mod) => `kh${mod}`,
      description: 'Keep the N highest dice.'
    },
    keepLowest: {
      id: 'keepLowest', label: 'Keep Lowest', category: 'filter',
      needsModifier: true, needsLimit: false,
      modifierMax: 'quantity', modifierMin: 1,
      notation: (g, mod) => `kl${mod}`,
      description: 'Keep the N lowest dice.'
    },
    dropHighest: {
      id: 'dropHighest', label: 'Drop Highest', category: 'filter',
      needsModifier: true, needsLimit: false,
      modifierMax: 'quantityMinus1', modifierMin: 1,
      notation: (g, mod) => `dh${mod}`,
      description: 'Drop the N highest dice.'
    },
    dropLowest: {
      id: 'dropLowest', label: 'Drop Lowest', category: 'filter',
      needsModifier: true, needsLimit: false,
      modifierMax: 'quantityMinus1', modifierMin: 1,
      notation: (g, mod) => `dl${mod}`,
      description: 'Drop the N lowest dice.'
    },
    explode: {
      id: 'explode', label: 'Explode', category: 'explosion',
      needsModifier: false, needsLimit: true, limitMin: 1,
      notation: (g, mod, limitOp, limitVal) => `!${limitOp}${limitVal}`,
      description: 'When a die rolls the trigger value, add another die (explosion).'
    },
    explodeCompounding: {
      id: 'explodeCompounding', label: 'Explode (Compounding)', category: 'explosion',
      needsModifier: false, needsLimit: true, limitMin: 1,
      notation: (g, mod, limitOp, limitVal) => `!!${limitOp}${limitVal}`,
      description: 'Exploded dice are added together into a single result.'
    },
    penetrate: {
      id: 'penetrate', label: 'Penetrating', category: 'explosion',
      needsModifier: false, needsLimit: false,
      notation: () => 'p',
      description: 'Penetrating explosion (World of Darkness style).'
    },
    reroll: {
      id: 'reroll', label: 'Reroll', category: 'reroll',
      needsModifier: true, needsLimit: true,
      modifierMax: 10, modifierMin: 1, limitMin: 1,
      notation: (g, mod, limitOp, limitVal) => {
        const times = (mod > 1) ? `${mod}` : '';
        return `r${times}${limitOp}${limitVal}`;
      },
      description: 'Reroll dice that meet the trigger condition N times.'
    },
    rerollOnce: {
      id: 'rerollOnce', label: 'Reroll Once', category: 'reroll',
      needsModifier: false, needsLimit: true, limitMin: 1,
      notation: (g, mod, limitOp, limitVal) => `ro${limitOp}${limitVal}`,
      description: 'Reroll dice that meet the trigger condition exactly once.'
    },
    explodeAndReroll: {
      id: 'explodeAndReroll', label: 'Explode & Reroll 1s', category: 'reroll',
      needsModifier: false, needsLimit: false,
      notation: () => 'er',
      description: 'Explodes on maximum and rerolls 1s (e.g., D&D 5e advantage).'
    },
    sortAscending: {
      id: 'sortAscending', label: 'Sort Ascending', category: 'sort',
      needsModifier: false, needsLimit: false,
      notation: () => 'sa',
      description: 'Sort dice results from lowest to highest.'
    },
    sortDescending: {
      id: 'sortDescending', label: 'Sort Descending', category: 'sort',
      needsModifier: false, needsLimit: false,
      notation: () => 'sd',
      description: 'Sort dice results from highest to lowest.'
    },
    criticalSuccess: {
      id: 'criticalSuccess', label: 'Critical Success', category: 'critical',
      needsModifier: false, needsLimit: true, limitMin: 2,
      notation: (g, mod, limitOp, limitVal) => `cs${limitOp}${limitVal}`,
      description: 'Rolls >= N are critical successes.'
    },
    criticalFailure: {
      id: 'criticalFailure', label: 'Critical Failure', category: 'critical',
      needsModifier: false, needsLimit: true, limitMin: 1,
      notation: (g, mod, limitOp, limitVal) => `cf${limitOp}${limitVal}`,
      description: 'Rolls <= N are critical failures.'
    },
    targetNumber: {
      id: 'targetNumber', label: 'Target Number', category: 'success',
      needsModifier: true, needsLimit: false,
      modifierMax: 100, modifierMin: 1,
      notation: (g, mod) => `t${mod}`,
      description: 'Count dice >= N as successes.'
    },
    failures: {
      id: 'failures', label: 'Failures', category: 'success',
      needsModifier: true, needsLimit: false,
      modifierMax: 100, modifierMin: 1,
      notation: (g, mod) => `f${mod}`,
      description: 'Count dice < N as failures.'
    },
    none: {
      id: 'none', label: 'None', category: 'none',
      needsModifier: false, needsLimit: false,
      notation: () => '',
      description: 'No rule applied.'
    }
  };

  const RULE_CATEGORIES = {
    none: { label: 'No Rule', order: 0 },
    filter:  { label: 'Keep/Drop', order: 1 },
    explosion: { label: 'Explosions', order: 2 },
    reroll: { label: 'Rerolls', order: 3 },
    sort: { label: 'Sorting', order: 4 },
    critical: { label: 'Criticals', order: 5 },
    success: { label: 'Success Counting', order: 6 }
  };

  // ============================================================
  // 2. THEME PALETTES
  // ============================================================
  const LIGHT_PALETTE = {
    // — Neutrals: the 3 main colours doing most of the work.
    background:   '#fafaf9',
    surface:      '#f4f3f1',
    surfaceHover: '#eae8e4',

    text:       '#1c1c1c',
    textMuted:  '#6b6b6b',
    textSubtle: '#9c9c9c',

    border:       '#e6e4df',
    borderHover:  '#d5d2cb',
    borderSubtle: '#eeebe6',

    inputBg: '#ffffff',
    shadow:  'rgba(28, 28, 28, 0.08)',

    // — Accent 1: warm muted clay. Primary actions, focus rings.
    primary:      '#b5614f',
    primaryHover: '#9d4f3f',
    primaryRing:  'rgba(181, 97, 79, 0.14)',

    // — Semantic: muted, kept in their traditional hue families.
    success: '#5c8a63',   // sage green
    danger:  '#a55047',   // brick red
    warning: '#a67c4a',   // ochre amber

    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
  };

  const DARK_PALETTE = {
    background:   '#1c1c1c',
    surface:      '#242424',
    surfaceHover: '#2e2e2e',

    text:       '#edece9',
    textMuted:  '#9c9c9c',
    textSubtle: '#6b6b6b',

    border:       '#333330',
    borderHover:  '#464540',
    borderSubtle: '#252522',

    inputBg: '#242424',
    shadow:  'rgba(0, 0, 0, 0.55)',

    // — Accent 1: same hue, lifted for dark bg contrast.
    primary:      '#d09b8c',
    primaryHover: '#ddb1a4',
    primaryRing:  'rgba(208, 155, 140, 0.22)',

    // — Semantic: same hues, lifted the same amount.
    success: '#8fb895',   // lifted sage
    danger:  '#d1877e',   // lifted brick
    warning: '#c9a678',   // lifted ochre

    fontFamily: LIGHT_PALETTE.fontFamily
  };

  // ============================================================
  // 3. DEFAULTS
  // ============================================================
  const DEFAULT_TRIGGER_ICON = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.75"
         stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="m14 7 3 3"/>
      <path d="M5 6v4"/>
      <path d="M19 14v4"/>
      <path d="M10 2v2"/>
      <path d="M7 8H3"/>
      <path d="M21 16h-4"/>
      <path d="M11 3H9"/>
      <path d="M17 15h-2"/>
      <path d="M3 21 21 3"/>
    </svg>
  `;

  const DEFAULTS = {
    dieTypes: ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'],
    comparisonOps: ['=', '>', '<'],
    theme: { mode: 'light', colors: {} },
    labels: {
      title: 'Dice Notation Builder',
      addGroup: 'Add Group',
      updateGroup: 'Update',
      clearAll: 'Clear All',
      copy: 'Copy',
      copied: 'Copied!',
      notation: 'Notation:',
      noGroups: 'No groups added yet',
      manualPlaceholder: 'Or type notation manually...',
      apply: 'Apply',
      baseDie: 'Base Die',
      rule: 'Rule',
      modifiers: 'Modifiers',
      bonus: 'Bonus',
      noModifiers: 'No modifiers needed',
      amount: 'Amount',
      trigger: 'Trigger',
      invalid: 'Invalid',
      close: 'Close',
      accept: 'Accept',
      addRule: 'Add Rule',
      removeRule: 'Remove',
      help: 'Help',
      backToBuilder: 'Back to builder',
      openBuilder: 'Open dice notation builder',
      glossaryTitle: 'Notation Guide',
      glossaryClose: 'Close Glossary'
    },
    callbacks: {
      onChange: null, onGroupAdd: null, onGroupRemove: null, onClear: null,
      onAccept: null, onClose: null, onError: null, onValidate: null
    },
    features: {
      allowManual: true, showPreview: true, showHelp: true,
      autoValidate: true, showCategories: true
    },
    popup: {
      enabled: false,
      targetInput: null,
      trigger: 'focus',          // 'focus' | 'button' | 'both'
      triggerIcon: DEFAULT_TRIGGER_ICON,
      width: '80vw',
      maxHeight: '80vh',
      closeOnOutsideClick: true,
      closeOnEscape: true
    },
    validator: null
  };

  // ============================================================
  // 4. HELPERS
  // ============================================================
  function deepMerge(target, source) {
    const result = { ...target };
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
  function getElement(el) {
    return typeof el === 'string' ? document.querySelector(el) : el;
  }
  function safeCall(fn, ...args) {
    try { if (fn && typeof fn === 'function') return fn(...args); } catch (_) {}
  }

  // ============================================================
  // 5. MAIN CLASS
  // ============================================================
  class DieBuilder {
    /**
     * Create a new DieBuilder instance. The `config` object is deep-merged over
     * the built-in `DEFAULTS`, so any subset of keys may be supplied.
     *
     * @param {Object} [config={}]
     * @param {string[]} [config.dieTypes] - Die types shown in the picker.
     * @param {Object} [config.theme]
     * @param {'light'|'dark'} [config.theme.mode='light']
     * @param {Partial<typeof LIGHT_PALETTE>} [config.theme.colors={}]
     *   Palette overrides — see the Theming section of the README.
     * @param {Partial<typeof DEFAULTS.labels>} [config.labels]
     * @param {Object} [config.callbacks]
     * @param {NotationCallback} [config.callbacks.onChange]
     * @param {NotationCallback} [config.callbacks.onGroupAdd]
     * @param {NotationCallback} [config.callbacks.onGroupRemove]
     * @param {NotationCallback} [config.callbacks.onClear]
     * @param {(notation: string, groups: Group[]) => void} [config.callbacks.onAccept]
     *   Fired when the popup is accepted with valid state.
     * @param {() => void} [config.callbacks.onClose]
     * @param {(err: Error) => void} [config.callbacks.onError]
     * @param {(result: ValidationResult) => void} [config.callbacks.onValidate]
     * @param {Object} [config.features]
     * @param {boolean} [config.features.allowManual=true]
     * @param {boolean} [config.features.showPreview=true]
     * @param {boolean} [config.features.showHelp=true]
     * @param {boolean} [config.features.autoValidate=true]
     * @param {boolean} [config.features.showCategories=true]
     * @param {Object} [config.popup]
     * @param {boolean} [config.popup.enabled=false]
     * @param {string|HTMLElement} [config.popup.targetInput=null]
     * @param {'focus'|'button'|'both'} [config.popup.trigger='focus']
     * @param {string} [config.popup.triggerIcon] - Inline SVG for the trigger.
     * @param {string} [config.popup.width='80vw']
     * @param {string} [config.popup.maxHeight='80vh']
     * @param {boolean} [config.popup.closeOnOutsideClick=true]
     * @param {boolean} [config.popup.closeOnEscape=true]
     * @param {CustomValidator} [config.validator=null]
     *
     * @example
     * const builder = new DieBuilder({
     *   theme: { mode: 'dark' },
     *   callbacks: { onChange: (n, gs) => console.log(n, gs) }
     * });
     */
    constructor(config = {}) {
      this.config = deepMerge(DEFAULTS, config);
      this.container = null;
      this.popupContainer = null;
      this.triggerBtn = null;
      this.targetInput = null;
      this.groups = [];
      this.groupCounter = 0;
      this._eventListeners = [];
      this._isPopup = false;
      this._isVisible = false;
      this._helpVisible = false;
      this._error = null;
      this._clickingInside = false;
      this._clickingInsideTimer = null;
      this._lastInputValue = null;
      this._suppressFocus = false;
      this._focusTrapHandler = null;
      this._faceResizeObserver = null;
      this._triggerScrollHandler = null;
      this._triggerResizeHandler = null;
      this._originalPaddingRight = null;
      this._triggerStyleEl = null;
      this._lastSyncedHeight = 0;
      this._initialHeightSet = false;
      this._instanceId = 'db-' + Math.random().toString(36).slice(2, 9);

      if (this.config.callbacks.onNotationChange && !this.config.callbacks.onChange) {
        this.config.callbacks.onChange = this.config.callbacks.onNotationChange;
      }
    }

    _resolvePalette() {
      const mode = this.config.theme.mode === 'dark' ? 'dark' : 'light';
      const base = mode === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
      return { ...base, ...(this.config.theme.colors || {}) };
    }

    // ============================================================
    // 5a. CONFIGURATION API
    // ============================================================
    /**
     * Merge a partial config into the live instance and re-render.
     * Safe to call at any time; preserves current groups and notation.
     *
     * @param {Object} config - Any subset of the constructor config.
     * @returns {this}
     *
     * @example
     * builder.setConfig({ theme: { mode: 'dark' } });
     */
    setConfig(config) {
      this.config = deepMerge(this.config, config);
      if (this.container) {
        this._renderStandalone();
        this._bindCommonEvents();
        this._bindFormEvents();
        this._renderGroups();
        this._updateOutput();
      } else if (this.popupContainer && this._isPopup) {
        this._renderPopup();
        this._bindPopupEvents();
        this._bindCommonEvents();
        this._bindFormEvents();
        this._bindFaceResizeObserver();
        this._renderGroups();
        this._updateOutput();
      }
      return this;
    }

    // ============================================================
    // 5b. INIT / ATTACH
    // ============================================================
    /**
     * Convenience wrapper for {@link DieBuilder#inject}, with a config override.
     *
     * @param {string|HTMLElement} element - Container selector or element.
     * @param {Object} [options={}] - Config overrides for this instance.
     * @returns {this}
     */
    init(element, options = {}) {
      if (Object.keys(options).length > 0) this.config = deepMerge(this.config, options);
      return this.inject(element);
    }

    inject(selector) {
      this.container = getElement(selector);
      if (!this.container) { this._handleError(new Error('Container not found')); return this; }
      this._isPopup = false;
      this._renderStandalone();
      this._bindCommonEvents();
      this._bindFormEvents();
      this._renderGroups();
      this._updateOutput();
      return this;
    }

    attachTo(inputSelector, options = {}) {
      if (options) this.config = deepMerge(this.config, options);
      this.targetInput = getElement(inputSelector || this.config.popup.targetInput);
      if (!this.targetInput) { this._handleError(new Error('Target input not found')); return this; }

      this.config.popup.enabled = true;
      this._isPopup = true;
      const trigger = this.config.popup.trigger;
      const useButton = trigger === 'button' || trigger === 'both';

      // Input accessibility
      if (!this.targetInput.id) this.targetInput.id = this._instanceId + '-input';
      this.targetInput.setAttribute('aria-haspopup', 'dialog');
      this.targetInput.setAttribute('aria-expanded', 'false');
      this.targetInput.setAttribute('autocomplete', 'off');

      // Popup container
      this.popupContainer = document.createElement('div');
      this.popupContainer.className = 'die-builder-popup';
      this.popupContainer.style.display = 'none';
      this.popupContainer.setAttribute('role', 'dialog');
      this.popupContainer.setAttribute('aria-modal', 'true');
      this.popupContainer.setAttribute('aria-labelledby', this._instanceId + '-title');
      document.body.appendChild(this.popupContainer);

      this.popupContainer.addEventListener('mousedown', () => {
        this._clickingInside = true;
        clearTimeout(this._clickingInsideTimer);
        this._clickingInsideTimer = setTimeout(() => { this._clickingInside = false; }, 400);
      });

      this._renderPopup();
      this._bindPopupEvents();
      this._bindCommonEvents();
      this._bindFormEvents();
      this._bindFaceResizeObserver();
      this._bindFocusTrap();

      this._lastInputValue = (this.targetInput.value || '').trim();
      if (this._lastInputValue) this._parseAndSetNotation(this._lastInputValue);

      this._renderGroups();
      this._updateOutput();
      this._emitValidation();

      // Focus trigger (opt-in)
      if (trigger === 'focus' || trigger === 'both') {
        this.targetInput.addEventListener('focus', () => {
          if (this._suppressFocus) return;
          this.show();
        });
      }

      // Blur: only close when in focus-only mode. In button/both mode,
      // focus loss shouldn't dismiss because the user clicked the button.
      if (trigger === 'focus') {
        this.targetInput.addEventListener('blur', () => {
          setTimeout(() => {
            if (this._clickingInside) return;
            if (this._isVisible && !this.popupContainer.contains(document.activeElement)) {
              this.hide(false);
            }
          }, 150);
        });
      }

      // Enter closes without re-parsing (keeps what the user typed)
      this.targetInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && this._isVisible) {
          e.preventDefault();
          this.hide(false);
        }
      });

      // Outside click always closes
      if (this.config.popup.closeOnOutsideClick) {
        document.addEventListener('click', (e) => {
          if (this._clickingInside) return;
          if (this.triggerBtn && this.triggerBtn.contains(e.target)) return;
          if (this._isVisible &&
              !this.popupContainer.contains(e.target) &&
              e.target !== this.targetInput) {
            this.hide(false);
          }
        });
      }

      if (this.config.popup.closeOnEscape) {
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && this._isVisible) this.hide(false);
        });
      }

      window.addEventListener('scroll', () => {
        this._positionPopup();
        this._positionTrigger();
      }, true);
      window.addEventListener('resize', () => {
        this._positionPopup();
        this._positionTrigger();
      });

      // Explicit trigger button
      if (useButton) this._createTriggerButton();

      // Reposition on focus — input may have moved since last render
      this.targetInput.addEventListener('focus', () => this._positionTrigger());

      return this;
    }

    // ============================================================
    // 5c. TRIGGER BUTTON
    // ============================================================
    _createTriggerButton() {
      if (!this.targetInput) return;
      if (this.triggerBtn) return;

      const c = this._resolvePalette();
      const uid = this._instanceId;

      // Inject trigger styles into <head> (not the popup) so they apply
      // to the body-level button regardless of popup DOM scoping.
      if (!this._triggerStyleEl) {
        const style = document.createElement('style');
        style.id = 'db-trigger-style-' + uid;
        style.textContent = `
          .db-trigger-btn-${uid} {
            position: fixed;
            z-index: 9998;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            margin: 0;
            border: 1px solid transparent;
            background: transparent;
            color: ${c.textMuted};
            border-radius: 6px;
            cursor: pointer;
            font-family: ${c.fontFamily};
            box-sizing: border-box;
            line-height: 1;
            -webkit-tap-highlight-color: transparent;
          }
          .db-trigger-btn-${uid}:hover {
            background: ${c.surfaceHover};
            color: ${c.primary};
          }
          .db-trigger-btn-${uid}:focus-visible {
            outline: 2px solid ${c.primary};
            outline-offset: 1px;
          }
          .db-trigger-btn-${uid}:active {
            background: ${c.primaryRing};
          }
          .db-trigger-btn-${uid} svg { display: block; }
        `;
        document.head.appendChild(style);
        this._triggerStyleEl = style;
      }

      // Leave room for the chevron inside the input
      this._originalPaddingRight = this.targetInput.style.paddingRight;
      const padRight = parseInt(getComputedStyle(this.targetInput).paddingRight, 10) || 0;
      if (padRight < 36) this.targetInput.style.paddingRight = '36px';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'db-trigger-btn db-trigger-btn-' + uid;
      btn.setAttribute('aria-label', this.config.labels.openBuilder);
      btn.setAttribute('title', this.config.labels.openBuilder);
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = this.config.popup.triggerIcon || DEFAULT_TRIGGER_ICON;

      // Belt-and-braces: inline the critical layout styles so the button
      // is still usable even if the injected CSS is somehow blocked.
      Object.assign(btn.style, {
        position: 'fixed',
        zIndex: '9998',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0',
        margin: '0',
        border: '1px solid transparent',
        background: 'transparent',
        cursor: 'pointer',
        boxSizing: 'border-box'
      });
      btn.style.color = c.textMuted;

      // Prevent the input from losing focus when the chevron is clicked
      btn.addEventListener('mousedown', (e) => e.preventDefault());

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._suppressFocus = true;
        setTimeout(() => { this._suppressFocus = false; }, 200);
        if (this._isVisible) {
          this.hide(false);
        } else {
          const v = (this.targetInput.value || '').trim();
          if (v !== (this._lastInputValue || '')) {
            this._lastInputValue = v;
            this._parseAndSetNotation(v);
            this._refreshForm();
          }
          this.show();
        }
      });

      document.body.appendChild(btn);
      this.triggerBtn = btn;

      // Position now, again after the next frame, and again after fonts /
      // late CSS have settled (in case the input hadn't laid out yet).
      this._positionTrigger();
      requestAnimationFrame(() => this._positionTrigger());
      setTimeout(() => this._positionTrigger(), 150);
    }

    _positionTrigger() {
      if (!this.triggerBtn || !this.targetInput) return;

      // Hide while the popup is open
      if (this._isVisible) {
        this.triggerBtn.style.display = 'none';
        return;
      }

      const rect = this.targetInput.getBoundingClientRect();

      // Hide if the input isn't laid out (0×0) — avoids positioning
      // the chevron off-screen at top:0/left:0
      if (rect.width === 0 || rect.height === 0) {
        this.triggerBtn.style.display = 'none';
        return;
      }

      // Hide if the input is off-screen
      const inView = rect.bottom > -20 && rect.top < (window.innerHeight + 20);
      if (!inView) {
        this.triggerBtn.style.display = 'none';
        return;
      }

      // Size scales with the input height, clamped for touch targets
      const size = Math.max(22, Math.min(28, rect.height - 8));
      const inset = 4;
      const top = rect.top + (rect.height - size) / 2;
      const left = rect.right - size - inset;

      const btn = this.triggerBtn;
      btn.style.display = 'inline-flex';
      btn.style.top = top + 'px';
      btn.style.left = left + 'px';
      btn.style.width = size + 'px';
      btn.style.height = size + 'px';
    }

    _destroyTriggerButton() {
      if (this.triggerBtn) {
        this.triggerBtn.remove();
        this.triggerBtn = null;
      }
      if (this._triggerStyleEl) {
        this._triggerStyleEl.remove();
        this._triggerStyleEl = null;
      }
      if (this.targetInput && this._originalPaddingRight !== null) {
        this.targetInput.style.paddingRight = this._originalPaddingRight;
        this._originalPaddingRight = null;
      }
    }

    // ============================================================
    // 5d. POPUP CONTROL
    // ============================================================
    show() {
      if (!this._isPopup) return;

      const currentInput = (this.targetInput.value || '').trim();
      if (currentInput !== (this._lastInputValue || '')) {
        this._lastInputValue = currentInput;
        this._parseAndSetNotation(currentInput);
        this._refreshForm();
      }

      this._isVisible = true;
      this.popupContainer.style.display = 'block';
      this.targetInput.setAttribute('aria-expanded', 'true');
      if (this.triggerBtn) {
        this.triggerBtn.setAttribute('aria-expanded', 'true');
        this.triggerBtn.style.display = 'none';
      }
      this._positionPopup();
      this._updateOutput();
      this._emitValidation();

      // Ensure the height is right after layout, without animating on first open
      const inner = this.popupContainer.querySelector('.db-flip-inner');
      if (inner) {
        if (!this._initialHeightSet) {
          // Suppress the height transition for the very first paint
          const prevTransition = inner.style.transition;
          inner.style.transition = 'none';
          void this.popupContainer.offsetHeight;
          this._syncFlipHeight();
          void inner.offsetHeight;
          inner.style.transition = prevTransition || '';
          this._initialHeightSet = true;
        } else {
          void this.popupContainer.offsetHeight;
          this._syncFlipHeight();
        }
      }

      // And again after paint, in case fonts / SVGs changed layout
      requestAnimationFrame(() => this._syncFlipHeight());
    }

    hide(accept = false) {
      if (!this._isPopup) return;

      if (accept) {
        // Validate BEFORE hiding. If it fails, keep the popup open and
        // surface errors inline so the user actually sees them.
        const result = this.validate();
        if (!result.valid) {
          this._showInlineErrors(result.errors);
          this._emitValidation();
          // Ensure the popup stays visible
          this._isVisible = true;
          this.popupContainer.style.display = 'block';
          this.targetInput.setAttribute('aria-expanded', 'true');
          if (this.triggerBtn) this.triggerBtn.style.display = 'none';
          this._syncFlipHeight();
          return;
        }

        // Valid — commit and close
        this._clearInlineErrors();
        this._isVisible = false;
        this.popupContainer.style.display = 'none';
        this.targetInput.setAttribute('aria-expanded', 'false');
        if (this.triggerBtn) this.triggerBtn.setAttribute('aria-expanded', 'false');

        this.targetInput.value = result.notation;
        this._lastInputValue = result.notation;
        this.targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        this.targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        safeCall(this.config.callbacks.onAccept, result.notation, this.groups);
      } else {
        // Cancel — just close
        this._isVisible = false;
        this.popupContainer.style.display = 'none';
        this.targetInput.setAttribute('aria-expanded', 'false');
        if (this.triggerBtn) this.triggerBtn.setAttribute('aria-expanded', 'false');
        this._clearInlineErrors();
        safeCall(this.config.callbacks.onClose);
      }

      // Restore focus if it was inside the popup
      if (document.activeElement && this.popupContainer.contains(document.activeElement)) {
        this._suppressFocus = true;
        try { this.targetInput.focus({ preventScroll: true }); } catch (_) {}
        setTimeout(() => { this._suppressFocus = false; }, 150);
      }

      this._positionTrigger();
    }

    // ============================================================
    // 5e. NOTATION OPERATIONS
    // ============================================================
    getNotation() {
      const validGroups = this.groups.filter(g => this._isGroupValid(g));
      if (validGroups.length === 0) return '';
      return validGroups.map(g => this._buildGroupNotation(g)).join('+');
    }

    setNotation(notation) {
      this._parseAndSetNotation(notation);
      this._refreshForm();
      this._triggerChange();
      return this;
    }

    clear() {
      this.groups = [];
      this.groupCounter = 0;
      this._renderGroups();
      this._updateOutput();
      this._triggerChange('onClear');
      this._emitValidation();
      return this;
    }

    getGroups() { return [...this.groups]; }

    addGroup(groupData) {
      const group = this._defaultGroup();
      Object.assign(group, groupData);
      if (!group.rules || !Array.isArray(group.rules)) {
        group.rules = [{ id: 'none', ruleModifier: 1, limitOperator: '=', limitValue: 1 }];
      }
      group.id = `g${++this.groupCounter}`;
      this.groups.push(group);
      this._renderGroups();
      this._updateOutput();
      this._triggerChange('onGroupAdd', group);
      this._emitValidation();
      return this;
    }

    removeGroup(index) {
      if (index >= 0 && index < this.groups.length) {
        const removed = this.groups.splice(index, 1)[0];
        this._renderGroups();
        this._updateOutput();
        this._triggerChange('onGroupRemove', removed);
        this._emitValidation();
      }
      return this;
    }

    // ============================================================
    // 5f. VALIDATION API (external use)
    // ============================================================

    /**
     * Validate the current builder state.
     * @returns {{ valid: boolean, notation: string, errors: Array }}
     *  Each error: { field, message, groupId?, groupIndex?, ruleIndex?, ruleId? }
     */
    validate() {
      const notation = this.getNotation();
      const errors = [];
      this._validateGroups(this.groups, errors);
      this._validateCustom(notation, errors, this.groups);
      if (this.groups.length === 0) {
        errors.push({ field: 'notation', message: 'No groups defined' });
      } else if (!notation) {
        errors.push({ field: 'notation', message: 'Notation is empty' });
      }
      return { valid: errors.length === 0, notation, errors };
    }

    /**
     * Validate an arbitrary notation string without touching current state.
     * @returns {{ valid: boolean, notation: string, errors: Array }}
     */
    validateNotation(str) {
      const notation = (str || '').trim();
      const groups = this._parseToGroups(notation);
      const errors = [];
      this._validateGroups(groups, errors);
      this._validateCustom(notation, errors, groups);
      if (groups.length === 0) {
        errors.push({ field: 'notation', message: 'Notation is empty or could not be parsed' });
      }
      return { valid: errors.length === 0, notation, errors };
    }

    /** Quick boolean shortcut. */
    isValid() { return this.validate().valid; }

    // -- Internal validation helpers --

    _validateGroups(groups, errors) {
      groups.forEach((g, i) => {
        const dieMax = parseInt((g.dieType || 'd6').replace('d', '')) || 6;

        if (!g.quantity || g.quantity < 1) {
          errors.push({ field: 'quantity', groupId: g.id, groupIndex: i,
            message: 'Quantity must be at least 1' });
        } else if (g.quantity > 100) {
          errors.push({ field: 'quantity', groupId: g.id, groupIndex: i,
            message: 'Quantity cannot exceed 100' });
        }
        if (!g.dieType) {
          errors.push({ field: 'dieType', groupId: g.id, groupIndex: i,
            message: 'Die type is required' });
        }

        (g.rules || []).forEach((ruleEntry, ruleIdx) => {
          const ruleObj = RULE_DEFS[ruleEntry.id] || RULE_DEFS.none;
          if (ruleEntry.id === 'none') return;

          if (ruleObj.needsModifier) {
            let max = ruleObj.modifierMax;
            if (max === 'quantity') max = g.quantity;
            if (max === 'quantityMinus1') max = Math.max(1, g.quantity - 1);
            const min = ruleObj.modifierMin || 1;
            if (!ruleEntry.ruleModifier || ruleEntry.ruleModifier < min) {
              errors.push({ field: 'ruleModifier', groupId: g.id, groupIndex: i,
                ruleIndex: ruleIdx, ruleId: ruleEntry.id,
                message: `${ruleObj.label}: amount must be at least ${min}` });
            } else if (max && ruleEntry.ruleModifier > max) {
              errors.push({ field: 'ruleModifier', groupId: g.id, groupIndex: i,
                ruleIndex: ruleIdx, ruleId: ruleEntry.id,
                message: `${ruleObj.label}: amount cannot exceed ${max}` });
            }
          }
          if (ruleObj.needsLimit) {
            const min = ruleObj.limitMin || 1;
            if (!ruleEntry.limitValue || ruleEntry.limitValue < min) {
              errors.push({ field: 'limitValue', groupId: g.id, groupIndex: i,
                ruleIndex: ruleIdx, ruleId: ruleEntry.id,
                message: `${ruleObj.label}: trigger must be at least ${min}` });
            } else if (ruleEntry.limitValue > dieMax) {
              errors.push({ field: 'limitValue', groupId: g.id, groupIndex: i,
                ruleIndex: ruleIdx, ruleId: ruleEntry.id,
                message: `${ruleObj.label}: trigger cannot exceed ${dieMax} (die maximum)` });
            }
          }
        });
      });
    }

    _validateCustom(notation, errors, groups) {
      if (!this.config.validator || typeof this.config.validator !== 'function') return;
      try {
        const result = this.config.validator(notation, groups);
        if (typeof result === 'string') {
          errors.push({ field: 'custom', message: result });
        } else if (result === false) {
          errors.push({ field: 'custom', message: 'Invalid notation' });
        }
      } catch (e) {
        errors.push({ field: 'custom', message: e.message });
      }
    }

    _emitValidation() {
      if (this.config.callbacks.onValidate) {
        safeCall(this.config.callbacks.onValidate, this.validate());
      }
    }

    _showInlineErrors(errors) {
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;

      // Clear any existing inline error decoration first
      this._clearInlineErrors();

      // Track which groups have errors so we can render a banner per group
      const errorsByGroupId = {};
      const globalErrors = [];
      for (const err of errors) {
        if (err.groupId) {
          if (!errorsByGroupId[err.groupId]) errorsByGroupId[err.groupId] = [];
          errorsByGroupId[err.groupId].push(err);
        } else {
          globalErrors.push(err);
        }
      }

      // The form being edited may not have an id yet (new group).
      // Match by index when needed.
      const form = container.querySelector('.db-form');
      const activeGroupId = form?.dataset.groupId;

      // Banner in the current form
      if (form) {
        const relevant =
          (activeGroupId && errorsByGroupId[activeGroupId]) || globalErrors;
        const toShow = relevant && relevant.length ? relevant : errors.slice(0, 1);
        if (toShow.length) {
          const banner = document.createElement('div');
          banner.className = 'db-form-error-banner';
          banner.setAttribute('role', 'alert');
          banner.innerHTML = toShow
            .map(e => `<div>${this._escapeHtml(e.message)}</div>`)
            .join('');
          // Insert at the top of the form, spanning all columns
          form.insertBefore(banner, form.firstChild);
        }

        // Per-field highlighting
        for (const err of errors) {
          if (!err.field || err.field === 'notation' || err.field === 'custom') continue;
          const selector = err.field === 'ruleModifier'
            ? `.db-rule-mod[data-rule-idx="${err.ruleIndex}"]`
            : err.field === 'limitValue'
              ? `.db-limit-val[data-rule-idx="${err.ruleIndex}"]`
              : err.field === 'quantity'
                ? `.db-qty`
                : err.field === 'dieType'
                  ? `.db-die-type`
                  : null;
          if (!selector) continue;
          const el = form.querySelector(selector);
          if (el) el.classList.add('db-input-error');
        }
      }
    }

    _clearInlineErrors() {
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;
      container.querySelectorAll('.db-form-error-banner').forEach(el => el.remove());
      container.querySelectorAll('.db-input-error').forEach(el => el.classList.remove('db-input-error'));
    }

    _escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ============================================================
    // 5g. HELP / FLIP
    // ============================================================
    toggleHelp() {
      if (this._isPopup) {
        this._flipTo(!this._helpVisible);
      } else {
        this._helpVisible = !this._helpVisible;
        const container = this.container;
        const panel = container.querySelector('.db-help-panel');
        if (panel) {
          panel.style.display = this._helpVisible ? 'block' : 'none';
          if (this._helpVisible) this._populateHelp(container);
        }
        const helpBtn = container.querySelector('#db-help-btn');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', this._helpVisible ? 'true' : 'false');
      }
    }

    _flipTo(showBack) {
      const inner = this.popupContainer.querySelector('.db-flip-inner');
      if (!inner) return;

      const front = inner.querySelector('.db-flip-front');
      const back = inner.querySelector('.db-flip-back');
      if (!front || !back) return;

      this._helpVisible = showBack;
      inner.setAttribute('data-flipped', showBack ? 'true' : 'false');

      if (showBack) {
        front.setAttribute('inert', '');
        front.setAttribute('aria-hidden', 'true');
        back.removeAttribute('inert');
        back.removeAttribute('aria-hidden');
      } else {
        back.setAttribute('inert', '');
        back.setAttribute('aria-hidden', 'true');
        front.removeAttribute('inert');
        front.removeAttribute('aria-hidden');
      }

      const helpBtn = this.popupContainer.querySelector('#db-help-btn');
      if (helpBtn) helpBtn.setAttribute('aria-expanded', showBack ? 'true' : 'false');

      this._syncFlipHeight();

      setTimeout(() => {
        const targetFace = showBack ? back : front;
        const focusable = targetFace.querySelector(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable) focusable.focus();
      }, 320);
    }

    _syncFlipHeight() {
      if (!this._isPopup || !this.popupContainer) return;
      if (this.popupContainer.style.display === 'none') return;

      const inner = this.popupContainer.querySelector('.db-flip-inner');
      if (!inner) return;

      const active = inner.querySelector(this._helpVisible ? '.db-flip-back' : '.db-flip-front');
      if (!active) return;

      // Force reflow before measuring so we always get current layout
      void active.offsetHeight;

      const h = active.offsetHeight;
      if (h > 0) {
        inner.style.height = h + 'px';
      }
    }

    _bindFaceResizeObserver() {
      if (typeof ResizeObserver === 'undefined') return;
      if (!this.popupContainer) return;

      const inner = this.popupContainer.querySelector('.db-flip-inner');
      if (!inner) return;

      const front = inner.querySelector('.db-flip-front');
      const back = inner.querySelector('.db-flip-back');
      if (!front || !back) return;

      if (this._faceResizeObserver) this._faceResizeObserver.disconnect();

      this._faceResizeObserver = new ResizeObserver(() => this._syncFlipHeight());
      this._faceResizeObserver.observe(front);
      this._faceResizeObserver.observe(back);
    }

    _populateHelp(container) {
      const target = container || (this._isPopup ? this.popupContainer : this.container);
      const content = target.querySelector('.db-help-content');
      if (!content) return;
      let html = '';
      for (const cat in RULE_CATEGORIES) {
        const catLabel = RULE_CATEGORIES[cat].label;
        const rules = Object.values(RULE_DEFS).filter(r => r.category === cat);
        if (rules.length === 0) continue;
        html += `<div class="db-help-category"><strong>${catLabel}</strong>`;
        for (const rule of rules) {
          const example = rule.notation({ dieType: 'd6', quantity: 3 }, 2, '>', 4) || '—';
          html += `<div class="db-help-item">
            <span class="db-help-rule">${rule.label}</span>
            <span class="db-help-desc">${rule.description || ''}</span>
            <span class="db-help-example">e.g. ${example}</span>
          </div>`;
        }
        html += `</div>`;
      }
      content.innerHTML = html;
    }

    // ============================================================
    // 5h. FOCUS TRAP
    // ============================================================
    _bindFocusTrap() {
      this._focusTrapHandler = (e) => {
        if (e.key !== 'Tab' || !this._isVisible || !this._isPopup) return;
        if (this._clickingInside) return;

        const popupFocusables = Array.from(
          this.popupContainer.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter(el => el.offsetParent !== null && !el.closest('[inert]'));

        const cycle = [this.targetInput, ...popupFocusables];
        const idx = cycle.indexOf(document.activeElement);
        if (idx === -1) return;

        const next = e.shiftKey
          ? cycle[(idx - 1 + cycle.length) % cycle.length]
          : cycle[(idx + 1) % cycle.length];

        e.preventDefault();
        next.focus();
      };
      document.addEventListener('keydown', this._focusTrapHandler);
    }

    // ============================================================
    // 5i. ERROR HANDLING
    // ============================================================

    // Reserved for unexpected runtime errors (missing container, bad config).
    // Validation failures should go through _showInlineErrors().
    _handleError(error) {
      this._error = error;
      safeCall(this.config.callbacks.onError, error);
      console.error('[DieBuilder]', error);
    }

    // ============================================================
    // 5j. INTERNAL RENDER
    // ============================================================
    _renderStandalone() {
      this.container.innerHTML = this._buildHTML(false);
      this._applyStyles(false);
      this._populateHelp(this.container);
    }

    _renderPopup() {
      this.popupContainer.innerHTML = this._buildHTML(true);
      this._applyStyles(true);
      this._populateHelp(this.popupContainer);
    }

    _refreshForm() {
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;
      const builderArea = container.querySelector('#db-group-builder');
      if (builderArea) builderArea.innerHTML = this._renderGroupForm();
      this._bindFormEvents();
      this._renderGroups();
      this._updateOutput();
      this._syncFlipHeight();
    }

    _buildHTML(isPopup) {
      const { labels, features } = this.config;
      const titleId = this._instanceId + '-title';
      const titleIdBack = this._instanceId + '-title-back';

      if (!isPopup) {
        const manual = features.allowManual ? `
          <div class="db-manual">
            <input type="text" id="db-manual-input" placeholder="${labels.manualPlaceholder}" aria-label="${labels.manualPlaceholder}" />
            <button id="db-manual-apply" type="button">${labels.apply}</button>
          </div>
        ` : '';

        return `
          <div class="die-builder" data-theme="${this.config.theme.mode}">
            <div class="db-header">
              <h3>${labels.title}</h3>
              <div class="db-header-actions">
                <button class="db-help-btn" id="db-help-btn" type="button"
                        title="${labels.help}" aria-label="${labels.help}"
                        aria-expanded="false" aria-controls="db-help-panel">
                  <span aria-hidden="true">?</span>
                </button>
              </div>
            </div>
            ${manual}
            <div class="db-help-panel" id="db-help-panel" style="display:none;" role="region" aria-label="${labels.glossaryTitle}">
              <div class="db-help-header">
                <span>${labels.glossaryTitle}</span>
                <button class="db-help-close" id="db-help-close" type="button">${labels.glossaryClose}</button>
              </div>
              <div class="db-help-content"></div>
            </div>
            <div class="db-group-builder" id="db-group-builder">${this._renderGroupForm()}</div>
            <div class="db-groups-header">
              <span id="${this._instanceId}-groups-label">Groups</span>
              <span class="db-groups-count" aria-hidden="true">${this.groups.length}</span>
            </div>
            <div class="db-groups" id="db-groups-list" role="list" aria-labelledby="${this._instanceId}-groups-label">
              <div class="db-empty">${labels.noGroups}</div>
            </div>
            <div class="db-footer">
              ${features.showPreview ? `
                <span class="db-preview">${labels.notation}
                  <strong id="db-preview-text" aria-live="polite" aria-atomic="true">—</strong>
                </span>
              ` : ''}
              <div class="db-actions">
                <button class="db-clear-btn" id="db-clear-btn" type="button">${labels.clearAll}</button>
                <button class="db-copy-btn" id="db-copy-btn" type="button">${labels.copy}</button>
              </div>
            </div>
          </div>
        `;
      }

      const acceptBtn = `<button class="db-accept-btn" id="db-accept-btn" type="button">${labels.accept}</button>`;

      return `
        <div class="die-builder" data-theme="${this.config.theme.mode}">
          <div class="db-flip-container">
            <div class="db-flip-inner" data-flipped="false">

              <div class="db-flip-face db-flip-front">
                <div class="db-face-card">
                  <div class="db-face-content">
                    <div class="db-header">
                      <h3 id="${titleId}">${labels.title}</h3>
                      <div class="db-header-actions">
                        <button class="db-help-btn" id="db-help-btn" type="button"
                                title="${labels.help}" aria-label="${labels.help}" aria-expanded="false">
                          <span aria-hidden="true">?</span>
                        </button>
                        <button class="db-close-btn" id="db-close-btn" type="button"
                                title="${labels.close}" aria-label="${labels.close}">
                          <span aria-hidden="true">✕</span>
                        </button>
                      </div>
                    </div>
                    <div class="db-group-builder" id="db-group-builder">${this._renderGroupForm()}</div>
                    <div class="db-groups-header">
                      <span id="${this._instanceId}-groups-label">Groups</span>
                      <span class="db-groups-count" aria-hidden="true">${this.groups.length}</span>
                    </div>
                    <div class="db-groups" id="db-groups-list" role="list" aria-labelledby="${this._instanceId}-groups-label">
                      <div class="db-empty">${labels.noGroups}</div>
                    </div>
                    <div class="db-footer">
                      ${features.showPreview ? `
                        <span class="db-preview">${labels.notation}
                          <strong id="db-preview-text" aria-live="polite" aria-atomic="true">—</strong>
                        </span>
                      ` : ''}
                      <div class="db-actions">
                        <button class="db-clear-btn" id="db-clear-btn" type="button">${labels.clearAll}</button>
                        <button class="db-copy-btn" id="db-copy-btn" type="button">${labels.copy}</button>
                        ${acceptBtn}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="db-flip-face db-flip-back" inert aria-hidden="true">
                <div class="db-face-card">
                  <div class="db-face-content">
                    <div class="db-header">
                      <h3 id="${titleIdBack}">${labels.glossaryTitle}</h3>
                      <div class="db-header-actions">
                        <button class="db-back-btn" id="db-back-btn" type="button"
                                title="${labels.backToBuilder}" aria-label="${labels.backToBuilder}">
                          <span aria-hidden="true">←</span>
                        </button>
                        <button class="db-close-btn" id="db-close-btn-back" type="button"
                                title="${labels.close}" aria-label="${labels.close}">
                          <span aria-hidden="true">✕</span>
                        </button>
                      </div>
                    </div>
                    <div class="db-help-content" id="db-help-content"></div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      `;
    }

    _renderGroupForm(groupData = null) {
      const isEdit = !!groupData;
      const g = groupData || this._defaultGroup();
      const { labels, features } = this.config;
      const categorizedRules = this._categorizeRules();

      let ruleEntries = '';
      const rulesArray = g.rules || [{ id: 'none', ruleModifier: 1, limitOperator: '=', limitValue: 1 }];
      rulesArray.forEach((ruleEntry, idx) => {
        ruleEntries += `
          <div class="db-rule-entry" data-rule-index="${idx}" role="group" aria-label="Rule ${idx + 1}">
            <div class="db-rule-fields">
              <select class="db-rule-selector" data-rule-idx="${idx}" aria-label="Rule type">
                ${Object.entries(categorizedRules).map(([cat, rules]) => `
                  <optgroup label="${RULE_CATEGORIES[cat]?.label || cat}">
                    ${rules.map(r => `<option value="${r.id}" ${ruleEntry.id === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
                  </optgroup>
                `).join('')}
              </select>
              ${this._renderRuleModifiers(ruleEntry, g, idx)}
            </div>
            ${rulesArray.length > 1 ? `
              <button class="db-rule-remove" data-rule-idx="${idx}" type="button"
                      title="${labels.removeRule}" aria-label="${labels.removeRule} rule ${idx + 1}">
                <span aria-hidden="true">✕</span>
              </button>` : ''}
          </div>
        `;
      });

      return `
        <div class="db-form" data-group-id="${g.id || 'new'}">
          <div class="db-col db-col-base">
            <label for="${this._instanceId}-qty-${g.id || 'new'}">${labels.baseDie}</label>
            <div class="db-field">
              <input type="number" id="${this._instanceId}-qty-${g.id || 'new'}"
                     class="db-qty" value="${g.quantity || 1}" min="1" max="100" aria-label="Quantity" />
              <select class="db-die-type" aria-label="Die type">
                ${this.config.dieTypes.map(d => `<option value="${d}" ${g.dieType === d ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="db-col db-col-rules">
            <span class="db-col-label" id="${this._instanceId}-rules-label">${labels.rule}</span>
            <div class="db-rules-container" role="group" aria-labelledby="${this._instanceId}-rules-label">
              ${ruleEntries}
              <button class="db-add-rule-btn" type="button">+ ${labels.addRule}</button>
            </div>
          </div>

          <div class="db-col db-col-bonus">
            <label for="${this._instanceId}-bonus-${g.id || 'new'}">${labels.bonus}</label>
            <div class="db-field">
              <input type="number" id="${this._instanceId}-bonus-${g.id || 'new'}"
                     class="db-bonus" value="${g.bonus || 0}" step="1" aria-label="Bonus modifier" />
            </div>
          </div>

          <div class="db-col db-col-actions">
            <button class="db-add-btn" type="button">${isEdit ? labels.updateGroup : labels.addGroup}</button>
          </div>
        </div>
      `;
    }

    _renderRuleModifiers(ruleEntry, group, idx) {
      const ruleObj = RULE_DEFS[ruleEntry.id] || RULE_DEFS.none;
      let html = '';
      if (ruleObj.needsModifier) {
        let max = ruleObj.modifierMax;
        if (max === 'quantity') max = group.quantity;
        if (max === 'quantityMinus1') max = Math.max(1, group.quantity - 1);
        const val = ruleEntry.ruleModifier || ruleObj.modifierMin || 1;
        html += `
          <input type="number" class="db-rule-mod" data-rule-idx="${idx}"
                 value="${val}" min="${ruleObj.modifierMin || 1}" max="${max || 100}" aria-label="Amount" />
        `;
      }
      if (ruleObj.needsLimit) {
        const dieMax = parseInt(group.dieType.replace('d', ''));
        const min = ruleObj.limitMin || 1;
        const currentVal = (ruleEntry.limitValue && ruleEntry.limitValue > 0) ? ruleEntry.limitValue : dieMax;
        html += `
          <select class="db-limit-op" data-rule-idx="${idx}" aria-label="Trigger comparison">
            ${this.config.comparisonOps.map(op => `<option value="${op}" ${ruleEntry.limitOperator === op ? 'selected' : ''}>${op}</option>`).join('')}
          </select>
          <input type="number" class="db-limit-val" data-rule-idx="${idx}"
                 value="${currentVal}" min="${min}" max="${dieMax}" aria-label="Trigger value" />
        `;
      }
      return html || `<span class="db-no-mod" aria-hidden="true">—</span>`;
    }

    _renderGroups() {
      const container = this._isPopup ? this.popupContainer : this.container;
      const list = container.querySelector('#db-groups-list');
      if (!list) return;

      const countEl = container.querySelector('.db-groups-count');
      if (countEl) countEl.textContent = this.groups.length;

      if (this.groups.length === 0) {
        list.innerHTML = `<div class="db-empty">${this.config.labels.noGroups}</div>`;
        return;
      }

      list.innerHTML = this.groups.map((g, index) => {
        const valid = this._isGroupValid(g);
        const notation = valid ? this._buildGroupNotation(g) : 'Invalid';
        const rulesStr = g.rules.map(r => RULE_DEFS[r.id]?.label || r.id).join(' · ');
        return `
          <div class="db-group-item ${valid ? '' : 'invalid'}" data-index="${index}" role="listitem">
            <div class="db-group-info">
              <span class="db-group-notation">${notation}</span>
              <span class="db-group-desc">${rulesStr}</span>
            </div>
            <div class="db-group-actions">
              <button class="db-edit-btn" data-index="${index}" type="button" aria-label="Edit group ${index + 1}">
                <span aria-hidden="true">✎</span>
              </button>
              <button class="db-remove-btn" data-index="${index}" type="button" aria-label="Remove group ${index + 1}">
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    _categorizeRules() {
      const categorized = {};
      for (const rule of Object.values(RULE_DEFS)) {
        if (!categorized[rule.category]) categorized[rule.category] = [];
        categorized[rule.category].push(rule);
      }
      const sorted = Object.keys(categorized).sort((a, b) =>
        (RULE_CATEGORIES[a]?.order ?? 99) - (RULE_CATEGORIES[b]?.order ?? 99)
      );
      const result = {};
      for (const cat of sorted) result[cat] = categorized[cat];
      return result;
    }

    // ============================================================
    // 5k. EVENT BINDING
    // ============================================================
    _bindCommonEvents() {
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;

      const manualInput = container.querySelector('#db-manual-input');
      const manualApply = container.querySelector('#db-manual-apply');
      if (manualApply && manualInput) {
        manualApply.addEventListener('click', () => { if (manualInput.value) this.setNotation(manualInput.value); });
        manualInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && manualInput.value) this.setNotation(manualInput.value);
        });
      }

      const clearBtn = container.querySelector('#db-clear-btn');
      if (clearBtn) clearBtn.addEventListener('click', () => this.clear());

      const copyBtn = container.querySelector('#db-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          const notation = this.getNotation();
          if (notation) {
            navigator.clipboard?.writeText(notation).then(() => {
              const orig = copyBtn.textContent;
              copyBtn.textContent = this.config.labels.copied;
              setTimeout(() => copyBtn.textContent = orig, 2000);
            }).catch(() => {
              const ta = document.createElement('textarea');
              ta.value = notation;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              ta.remove();
            });
          }
        });
      }

      const helpBtn = container.querySelector('#db-help-btn');
      if (helpBtn) helpBtn.addEventListener('click', () => this.toggleHelp());

      const backBtn = container.querySelector('#db-back-btn');
      if (backBtn) backBtn.addEventListener('click', () => this._flipTo(false));

      const helpClose = container.querySelector('#db-help-close');
      if (helpClose) {
        helpClose.addEventListener('click', () => {
          this._helpVisible = false;
          const panel = container.querySelector('.db-help-panel');
          if (panel) panel.style.display = 'none';
          const btn = container.querySelector('#db-help-btn');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        });
      }

      const groupsList = container.querySelector('#db-groups-list');
      if (groupsList) {
        groupsList.addEventListener('click', (e) => {
          const removeBtn = e.target.closest('.db-remove-btn');
          if (removeBtn) this.removeGroup(parseInt(removeBtn.dataset.index));
          const editBtn = e.target.closest('.db-edit-btn');
          if (editBtn) {
            const index = parseInt(editBtn.dataset.index);
            const group = this.groups[index];
            const builder = container.querySelector('#db-group-builder');
            builder.innerHTML = this._renderGroupForm(group);
            this._bindFormEvents();
            this._syncFlipHeight();
          }
        });
      }

      const builderArea = container.querySelector('#db-group-builder');
      if (builderArea) {
        builderArea.addEventListener('click', (e) => {
          const addBtn = e.target.closest('.db-add-btn');
          if (addBtn) {
            const form = addBtn.closest('.db-form');
            const group = this._collectFormData(form);
            const editId = form.dataset.groupId;
            if (editId && editId !== 'new') {
              const index = this.groups.findIndex(g => g.id === editId);
              if (index !== -1) { group.id = editId; this.groups[index] = group; }
            } else {
              group.id = `g${++this.groupCounter}`;
              this.groups.push(group);
            }
            builderArea.innerHTML = this._renderGroupForm();
            this._bindFormEvents();
            this._renderGroups();
            this._updateOutput();
            this._triggerChange('onGroupAdd', group);
            this._emitValidation();
            this._syncFlipHeight();
          }
        });

        builderArea.addEventListener('click', (e) => {
          const addRuleBtn = e.target.closest('.db-add-rule-btn');
          if (addRuleBtn) {
            const form = addRuleBtn.closest('.db-form');
            const group = this._collectFormData(form);
            if (!group.rules) group.rules = [];
            group.rules.push({ id: 'none', ruleModifier: 1, limitOperator: '=', limitValue: 1 });
            form.closest('#db-group-builder').innerHTML = this._renderGroupForm(group);
            this._bindFormEvents();
            this._syncFlipHeight();
          }
        });

        builderArea.addEventListener('click', (e) => {
          const removeRuleBtn = e.target.closest('.db-rule-remove');
          if (removeRuleBtn) {
            const idx = parseInt(removeRuleBtn.dataset.ruleIdx);
            const form = removeRuleBtn.closest('.db-form');
            const group = this._collectFormData(form);
            if (group.rules && group.rules.length > 1) {
              group.rules.splice(idx, 1);
              form.closest('#db-group-builder').innerHTML = this._renderGroupForm(group);
              this._bindFormEvents();
              this._syncFlipHeight();
            }
          }
        });

        builderArea.addEventListener('change', (e) => {
          const selector = e.target.closest('.db-rule-selector');
          if (selector) {
            const idx = parseInt(selector.dataset.ruleIdx);
            const form = selector.closest('.db-form');
            const group = this._collectFormData(form);
            if (group.rules && group.rules[idx]) {
              group.rules[idx].id = selector.value;
              const ruleObj = RULE_DEFS[selector.value] || RULE_DEFS.none;
              group.rules[idx].ruleModifier = ruleObj.modifierMin || 1;
              group.rules[idx].limitOperator = '=';
              const dieMax = parseInt((group.dieType || 'd6').replace('d','')) || 6;
              group.rules[idx].limitValue = ruleObj.needsLimit ? dieMax : (ruleObj.limitMin || 1);
              form.closest('#db-group-builder').innerHTML = this._renderGroupForm(group);
              this._bindFormEvents();
              this._syncFlipHeight();
            }
          }
        });
      }

      container.addEventListener('input', (e) => {
        // Clear inline errors as soon as the user starts correcting
        this._clearInlineErrors();

        if (this.config.features.autoValidate) {
          const form = e.target.closest('.db-form');
          if (form) {
            const group = this._collectFormData(form);
            if (this._isGroupValid(group)) {
              const previewEl = container.querySelector('#db-preview-text');
              if (previewEl) previewEl.textContent = this._buildGroupNotation(group);
            }
          }
        }

        // Debounced validation emit
        clearTimeout(this._validateDebounce);
        this._validateDebounce = setTimeout(() => this._emitValidation(), 200);
      });
    }

    _bindPopupEvents() {
      const container = this.popupContainer;
      const closeBtn = container.querySelector('#db-close-btn');
      if (closeBtn) closeBtn.addEventListener('click', () => this.hide(false));
      const closeBtnBack = container.querySelector('#db-close-btn-back');
      if (closeBtnBack) closeBtnBack.addEventListener('click', () => this.hide(false));
      const acceptBtn = container.querySelector('#db-accept-btn');
      if (acceptBtn) acceptBtn.addEventListener('click', () => this.hide(true));
    }

    _bindFormEvents() {
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;
      container.querySelectorAll('.db-qty').forEach(qty => {
        qty.addEventListener('change', () => {
          const form = qty.closest('.db-form');
          const qtyVal = parseInt(qty.value) || 1;
          form.querySelectorAll('.db-rule-mod').forEach(mod => {
            const max = qtyVal - 1;
            mod.max = max;
            if (parseInt(mod.value) > max) mod.value = max;
          });
        });
      });
    }

    // ============================================================
    // 5l. DATA COLLECTION
    // ============================================================
    _collectFormData(form) {
      const qty = parseInt(form.querySelector('.db-qty')?.value) || 1;
      const dieType = form.querySelector('.db-die-type')?.value || 'd6';
      const bonus = parseInt(form.querySelector('.db-bonus')?.value) || 0;
      const id = form.dataset.groupId || null;

      const rules = [];
      form.querySelectorAll('.db-rule-selector').forEach((sel) => {
        const idx = parseInt(sel.dataset.ruleIdx);
        const ruleModInput = form.querySelector(`.db-rule-mod[data-rule-idx="${idx}"]`);
        const limitOpInput = form.querySelector(`.db-limit-op[data-rule-idx="${idx}"]`);
        const limitValInput = form.querySelector(`.db-limit-val[data-rule-idx="${idx}"]`);
        rules.push({
          id: sel.value || 'none',
          ruleModifier: ruleModInput ? parseInt(ruleModInput.value) : 1,
          limitOperator: limitOpInput ? limitOpInput.value : '=',
          limitValue: limitValInput ? parseInt(limitValInput.value) : 1
        });
      });

      return { id, quantity: qty, dieType, rules, bonus };
    }

    _defaultGroup() {
      return {
        id: null, quantity: 1, dieType: 'd6',
        rules: [{ id: 'none', ruleModifier: 1, limitOperator: '=', limitValue: 1 }],
        bonus: 0
      };
    }

    _isGroupValid(group) {
      if (!group.quantity || group.quantity < 1) return false;
      if (!group.dieType) return false;
      if (!group.rules || group.rules.length === 0) return false;
      for (const ruleEntry of group.rules) {
        const ruleObj = RULE_DEFS[ruleEntry.id] || RULE_DEFS.none;
        if (ruleEntry.id === 'none') continue;
        if (ruleObj.needsModifier) {
          let max = ruleObj.modifierMax;
          if (max === 'quantity') max = group.quantity;
          if (max === 'quantityMinus1') max = Math.max(1, group.quantity - 1);
          if (!ruleEntry.ruleModifier || ruleEntry.ruleModifier < (ruleObj.modifierMin || 1)) return false;
          if (max && ruleEntry.ruleModifier > max) return false;
        }
        if (ruleObj.needsLimit) {
          const dieMax = parseInt(group.dieType.replace('d', ''));
          const min = ruleObj.limitMin || 1;
          if (!ruleEntry.limitValue || ruleEntry.limitValue < min) return false;
          if (ruleEntry.limitValue > dieMax) return false;
        }
      }
      return true;
    }

    _buildGroupNotation(group) {
      if (!this._isGroupValid(group)) return '';
      let parts = [`${group.quantity}${group.dieType}`];
      for (const ruleEntry of group.rules) {
        const ruleObj = RULE_DEFS[ruleEntry.id] || RULE_DEFS.none;
        const notation = ruleObj.notation(group, ruleEntry.ruleModifier, ruleEntry.limitOperator, ruleEntry.limitValue);
        if (notation) parts.push(notation);
      }
      if (group.bonus) parts.push(`${group.bonus > 0 ? '+' : ''}${group.bonus}`);
      return parts.join('');
    }

    // ============================================================
    // 5m. PARSING
    // ============================================================
    _parseToGroups(notation) {
      const groups = [];
      if (!notation || notation.trim() === '') return groups;

      const rulePatterns = [
        { id: 'keep', regex: /kh(\d+)/ },
        { id: 'keepLowest', regex: /kl(\d+)/ },
        { id: 'dropHighest', regex: /dh(\d+)/ },
        { id: 'dropLowest', regex: /dl(\d+)/ },
        { id: 'explodeCompounding', regex: /!!([><=])?(\d+)/ },
        { id: 'explode', regex: /!([><=])?(\d+)/ },
        { id: 'penetrate', regex: /p/ },
        { id: 'reroll', regex: /r(\d*)([><=])(\d+)/ },
        { id: 'rerollOnce', regex: /ro([><=])(\d+)/ },
        { id: 'explodeAndReroll', regex: /er/ },
        { id: 'sortAscending', regex: /sa/ },
        { id: 'sortDescending', regex: /sd/ },
        { id: 'criticalSuccess', regex: /cs([><=])(\d+)/ },
        { id: 'criticalFailure', regex: /cf([><=])(\d+)/ },
        { id: 'targetNumber', regex: /t(\d+)/ },
        { id: 'failures', regex: /f(\d+)/ }
      ];

      let remaining = notation.trim();
      let bonusAccumulator = 0;
      let counter = 0;
      let safety = 0;
      const MAX_ITER = 300;

      while (remaining.length > 0 && safety++ < MAX_ITER) {
        const skip = remaining.match(/^[\s+]+/);
        if (skip) { remaining = remaining.slice(skip[0].length); if (!remaining) break; }

        const dieMatch = remaining.match(/^(\d+)d(\d+)/);
        if (dieMatch) {
          const group = this._defaultGroup();
          group.id = `g${++counter}`;
          group.quantity = parseInt(dieMatch[1]);
          group.dieType = `d${dieMatch[2]}`;
          remaining = remaining.slice(dieMatch[0].length);

          const rules = [];
          let rulesRunning = true;
          while (rulesRunning && remaining.length > 0) {
            rulesRunning = false;
            for (const pattern of rulePatterns) {
              const m = remaining.match(pattern.regex);
              if (m && m.index === 0) {
                const ruleEntry = { id: pattern.id, ruleModifier: 1, limitOperator: '=', limitValue: 1 };
                if (['keep','keepLowest','dropHighest','dropLowest'].includes(pattern.id)) {
                  ruleEntry.ruleModifier = parseInt(m[1]);
                } else if (['explode','explodeCompounding'].includes(pattern.id)) {
                  ruleEntry.limitOperator = m[1] || '=';
                  ruleEntry.limitValue = parseInt(m[2]);
                } else if (pattern.id === 'reroll') {
                  ruleEntry.ruleModifier = parseInt(m[1]) || 1;
                  ruleEntry.limitOperator = m[2];
                  ruleEntry.limitValue = parseInt(m[3]);
                } else if (pattern.id === 'rerollOnce') {
                  ruleEntry.limitOperator = m[1];
                  ruleEntry.limitValue = parseInt(m[2]);
                } else if (['criticalSuccess','criticalFailure'].includes(pattern.id)) {
                  ruleEntry.limitOperator = m[1];
                  ruleEntry.limitValue = parseInt(m[2]);
                } else if (['targetNumber','failures'].includes(pattern.id)) {
                  ruleEntry.ruleModifier = parseInt(m[1]);
                }
                rules.push(ruleEntry);
                remaining = remaining.slice(m[0].length);
                rulesRunning = true;
                break;
              }
            }
          }

          const bonusMatch = remaining.match(/^([+-]\d+)(?![d\d])/);
          if (bonusMatch) {
            group.bonus = parseInt(bonusMatch[1]);
            remaining = remaining.slice(bonusMatch[0].length);
          }

          group.rules = rules.length > 0 ? rules : [{ id: 'none', ruleModifier: 1, limitOperator: '=', limitValue: 1 }];
          groups.push(group);
          continue;
        }

        const pureBonus = remaining.match(/^([+-]?\d+)(?![d\d])/);
        if (pureBonus) {
          bonusAccumulator += parseInt(pureBonus[1]);
          remaining = remaining.slice(pureBonus[0].length);
          continue;
        }

        remaining = remaining.slice(1);
      }

      if (bonusAccumulator !== 0 && groups.length > 0) {
        const last = groups[groups.length - 1];
        last.bonus = (last.bonus || 0) + bonusAccumulator;
      } else if (bonusAccumulator !== 0) {
        const g = this._defaultGroup();
        g.id = `g${++counter}`;
        g.bonus = bonusAccumulator;
        groups.push(g);
      }

      return groups;
    }

    _parseAndSetNotation(notation) {
      this.groups = this._parseToGroups(notation);
      this.groupCounter = this.groups.length;
    }

    // ============================================================
    // 5n. UI UPDATES
    // ============================================================
    _updateOutput() {
      const notation = this.getNotation();
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;
      const preview = container.querySelector('#db-preview-text');
      if (preview) preview.textContent = notation || '—';
    }

    _triggerChange(eventType, data) {
      const notation = this.getNotation();
      const callbacks = this.config.callbacks;
      safeCall(callbacks.onChange, notation, this.groups);
      if (eventType && callbacks[eventType]) safeCall(callbacks[eventType], notation, this.groups, data);
    }

    // ============================================================
    // 5o. POPUP POSITIONING
    // ============================================================
    _positionPopup() {
      if (!this.targetInput || !this.popupContainer) return;
      const rect = this.targetInput.getBoundingClientRect();
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      const popup = this.popupContainer;
      const popupW = Math.min(winW * 0.8, 800);
      const popupH = Math.min(winH * 0.8, 600);

      popup.style.width = popupW + 'px';
      popup.style.maxHeight = popupH + 'px';

      let left = rect.left + (rect.width - popupW) / 2;
      left = Math.max(10, Math.min(left, winW - popupW - 10));
      let top = rect.bottom + 8;
      if (top + popupH > winH - 10) top = rect.top - popupH - 8;
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    }

    // ============================================================
    // 5p. STYLES
    // ============================================================
    _applyStyles(isPopup) {
      const target = isPopup ? this.popupContainer : this.container;
      const style = document.createElement('style');
      style.textContent = this._getStyles(isPopup);
      target.appendChild(style);
    }

    _getStyles(isPopup) {
      const c = this._resolvePalette();

      const base = `
        /* ---------- THEME VARIABLES ---------- */
        .die-builder, .die-builder-popup, .db-trigger-btn {
          --db-font: ${c.fontFamily};
          --db-primary: ${c.primary};
          --db-primary-hover: ${c.primaryHover};
          --db-primary-ring: ${c.primaryRing};
          --db-success: ${c.success};
          --db-danger: ${c.danger};
          --db-warning: ${c.warning};
          --db-bg: ${c.background};
          --db-surface: ${c.surface};
          --db-surface-hover: ${c.surfaceHover};
          --db-text: ${c.text};
          --db-text-muted: ${c.textMuted};
          --db-text-subtle: ${c.textSubtle};
          --db-border: ${c.border};
          --db-border-hover: ${c.borderHover};
          --db-border-subtle: ${c.borderSubtle};
          --db-input-bg: ${c.inputBg};
          --db-shadow: ${c.shadow};
          --db-control-h: 34px;
          --db-flip-duration: 550ms;
        }

        /* ---------- TRIGGER BUTTON (floating on input) ---------- */
        .db-trigger-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          border: 1px solid transparent;
          background: transparent;
          color: var(--db-text-muted);
          border-radius: 6px;
          cursor: pointer;
          transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
          font-family: var(--db-font);
          box-sizing: border-box;
        }
        .db-trigger-btn:hover {
          background: var(--db-surface-hover);
          color: var(--db-primary);
        }
        .db-trigger-btn:focus-visible {
          outline: 2px solid var(--db-primary);
          outline-offset: 1px;
        }
        .db-trigger-btn:active {
          background: var(--db-surface);
        }

        /* ---------- BASE ---------- */
        .die-builder {
          font-family: var(--db-font);
          font-size: 13px;
          line-height: 1.5;
          color: var(--db-text);
          background: var(--db-bg);
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          box-sizing: border-box;
        }
        .die-builder *, .die-builder *::before, .die-builder *::after { box-sizing: border-box; }
        .die-builder :focus-visible { outline: 2px solid var(--db-primary); outline-offset: 2px; }

        /* ---------- HEADER ---------- */
        .db-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding-bottom: 14px;
          margin-bottom: 18px;
          border-bottom: 1px solid var(--db-border-subtle);
        }
        .db-header h3 {
          margin: 0;
          font-size: 15px;
          font-weight: 600;
          letter-spacing: -0.015em;
          color: var(--db-text);
        }
        .db-header-actions { display: flex; align-items: center; gap: 2px; }

        /* ---------- ICON BUTTONS ---------- */
        .db-help-btn, .db-close-btn, .db-back-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          padding: 0;
          border: none;
          background: transparent;
          color: var(--db-text-muted);
          font-size: 15px;
          font-weight: 400;
          font-family: inherit;
          border-radius: 6px;
          cursor: pointer;
          transition: background 150ms ease, color 150ms ease;
          line-height: 1;
        }
        .db-qty,
        .db-bonus,
        .db-rule-mod,
        .db-limit-val,
        .db-group-notation,
        .db-preview strong {
          font-variant-numeric: tabular-nums;
        }
        .db-help-btn:hover, .db-close-btn:hover, .db-back-btn:hover {
          background: var(--db-surface-hover);
          color: var(--db-text);
        }
        .db-help-btn:hover, .db-back-btn:hover { color: var(--db-primary); }
        .db-close-btn:hover { color: var(--db-danger); }

        /* ---------- MANUAL INPUT ---------- */
        .db-manual { display: flex; gap: 8px; margin-bottom: 16px; }
        .db-manual input {
          flex: 1;
          height: var(--db-control-h);
          padding: 0 12px;
          font-size: 13px;
          font-family: inherit;
          color: var(--db-text);
          background: var(--db-input-bg);
          border: 1px solid var(--db-border);
          border-radius: 8px;
          outline: none;
        }
        .db-manual input::placeholder { color: var(--db-text-subtle); }
        .db-manual input:hover { border-color: var(--db-border-hover); }
        .db-manual input:focus { border-color: var(--db-primary); box-shadow: 0 0 0 3px var(--db-primary-ring); }
        .db-manual button {
          height: var(--db-control-h);
          padding: 0 16px;
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
          color: white;
          background: var(--db-primary);
          border: none;
          border-radius: 8px;
          cursor: pointer;
          white-space: nowrap;
        }
        .db-manual button:hover { background: var(--db-primary-hover); }

        /* ---------- HELP PANEL (standalone) ---------- */
        .db-help-panel {
          background: var(--db-surface);
          border: 1px solid var(--db-border-subtle);
          border-radius: 10px;
          padding: 16px;
          margin-bottom: 16px;
          max-height: 320px;
          overflow-y: auto;
        }
        .db-help-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          color: var(--db-text-muted);
          margin-bottom: 12px;
        }
        .db-help-close {
          background: transparent;
          border: none;
          color: var(--db-primary);
          font-size: 11px;
          font-family: inherit;
          font-weight: 500;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 6px;
        }
        .db-help-close:hover { background: var(--db-surface-hover); }

        .db-help-content { font-size: 12.5px; }
        .db-help-category { margin-bottom: 14px; }
        .db-help-category:last-child { margin-bottom: 0; }
        .db-help-category > strong {
          display: block;
          font-size: 10.5px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--db-text-muted);
          margin-bottom: 8px;
        }
        .db-help-item {
          display: grid;
          grid-template-columns: 1fr 2fr auto;
          gap: 12px;
          align-items: baseline;
          padding: 6px 0;
          border-bottom: 1px solid var(--db-border-subtle);
        }
        .db-help-item:last-child { border-bottom: none; }
        .db-help-rule { font-weight: 500; color: var(--db-text); font-size: 12.5px; }
        .db-help-desc { color: var(--db-text-muted); font-size: 12px; }
        .db-help-example {
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
          font-size: 11.5px;
          color: var(--db-primary);
          background: var(--db-primary-ring);
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
        }

        /* ---------- FORM LAYOUT ---------- */
        .db-form {
          display: grid;
          grid-template-columns: minmax(140px, 1fr) minmax(220px, 2fr) minmax(90px, 0.6fr) minmax(90px, 0.6fr);
          gap: 16px;
          padding: 4px 0 18px;
          border-bottom: 1px solid var(--db-border-subtle);
          margin-bottom: 18px;
          align-items: start;
        }
        .db-col { min-width: 0; }
        .db-col > label,
        .db-col-label {
          display: block;
          font-size: 10px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.10em;
          color: var(--db-text-muted);
          margin-bottom: 7px;
          line-height: 1.2;
        }
        .db-field { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

        /* ---------- UNIFIED CONTROL STYLING ---------- */
        .db-qty, .db-die-type, .db-bonus, .db-rule-selector,
        .db-rule-mod, .db-limit-op, .db-limit-val {
          height: var(--db-control-h);
          padding: 0 10px;
          font-family: inherit;
          font-size: 13px;
          line-height: 1;
          color: var(--db-text);
          background: var(--db-input-bg);
          border: 1px solid var(--db-border);
          border-radius: 7px;
          outline: none;
          vertical-align: middle;
        }
        .db-qty:hover, .db-die-type:hover, .db-bonus:hover,
        .db-rule-selector:hover, .db-rule-mod:hover,
        .db-limit-op:hover, .db-limit-val:hover { border-color: var(--db-border-hover); }
        .db-qty:focus, .db-die-type:focus, .db-bonus:focus,
        .db-rule-selector:focus, .db-rule-mod:focus,
        .db-limit-op:focus, .db-limit-val:focus {
          border-color: var(--db-primary);
          box-shadow: 0 0 0 3px var(--db-primary-ring);
        }

        .db-qty { width: 64px; text-align: center; }
        .db-die-type { width: 76px; cursor: pointer; }
        .db-bonus { width: 76px; text-align: center; }
        .db-rule-mod { width: 56px; text-align: center; }
        .db-limit-val { width: 56px; text-align: center; }
        .db-limit-op { width: 52px; text-align: center; padding: 0 6px; cursor: pointer; }

        /* ---------- RULES CONTAINER ---------- */
        .db-rules-container { display: flex; flex-direction: column; gap: 6px; }
        .db-rule-entry {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 4px;
          background: transparent;
          border: none;
          border-radius: 8px;
          min-height: var(--db-control-h);
        }
        .db-rule-entry:hover {
          background: var(--db-surface);
          box-shadow: inset 0 0 0 1px var(--db-border-subtle);
        }
        .db-rule-entry:focus-within {
          background: var(--db-surface);
          box-shadow: inset 0 0 0 1px var(--db-border);
        }
        .db-rule-fields {
          display: flex; flex-wrap: wrap; align-items: center;
          gap: 6px; flex: 1; min-width: 0;
        }
        .db-rule-selector { flex: 1; min-width: 140px; cursor: pointer; }
        .db-rule-remove {
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; padding: 0;
          background: transparent; border: none; border-radius: 6px;
          color: var(--db-text-subtle); font-size: 12px;
          font-family: inherit; cursor: pointer; flex-shrink: 0;
        }
        .db-rule-remove:hover { background: rgba(220,38,38,0.1); color: var(--db-danger); }
        .db-add-rule-btn {
          align-self: flex-start;
          height: 28px; padding: 0 12px;
          font-size: 12px; font-weight: 500; font-family: inherit;
          color: var(--db-text-muted);
          background: transparent;
          border: 1px dashed var(--db-border);
          border-radius: 7px;
          cursor: pointer;
          line-height: 1;
        }
        .db-add-rule-btn:hover {
          color: var(--db-primary);
          border-color: var(--db-primary);
          background: var(--db-primary-ring);
          border-style: solid;
        }
        .db-no-mod {
          display: inline-flex; align-items: center;
          height: var(--db-control-h);
          padding: 0 4px;
          color: var(--db-text-subtle);
          font-size: 12px;
        }

        /* ---------- ADD GROUP ---------- */
        .db-add-btn {
          width: 100%; height: var(--db-control-h);
          padding: 0 14px;
          font-size: 13px; font-weight: 500; font-family: inherit;
          color: white; background: var(--db-primary);
          border: none; border-radius: 8px; cursor: pointer;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
          line-height: 1;
        }
        .db-add-btn:hover { background: var(--db-primary-hover); box-shadow: 0 2px 4px rgba(15,23,42,0.12); }
        .db-add-btn:active { transform: translateY(1px); }

        /* ---------- GROUPS LIST ---------- */
        .db-groups-header {
          display: flex; align-items: center; justify-content: space-between;
          font-size: 10.5px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 0.08em;
          color: var(--db-text-muted); margin-bottom: 8px;
        }
        .db-groups-count {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 20px; height: 20px; padding: 0 6px;
          font-size: 10.5px; font-weight: 600;
          color: var(--db-text-muted); background: var(--db-surface);
          border-radius: 10px;
        }
        .db-groups { display: flex; flex-direction: column; gap: 4px; min-height: 44px; margin-bottom: 16px; }
        .db-empty {
          text-align: center; color: var(--db-text-subtle); font-size: 12.5px;
          padding: 20px 12px; border: 1px dashed var(--db-border-subtle); border-radius: 8px;
        }
        .db-group-item {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; padding: 8px 12px;
          background: var(--db-surface);
          border: 1px solid transparent; border-radius: 8px;
        }
        .db-group-item:hover { border-color: var(--db-border); }
        .db-group-item.invalid { opacity: 0.55; }
        .db-group-item.invalid .db-group-notation { color: var(--db-danger); }
        .db-group-info {
          display: flex; align-items: baseline; gap: 12px;
          flex-wrap: wrap; min-width: 0; flex: 1;
        }
        .db-group-notation {
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
          font-size: 13px; font-weight: 500; color: var(--db-text); letter-spacing: -0.01em;
        }
        .db-group-desc {
          font-size: 10.5px;
          font-weight: 500;
          color: var(--db-text-subtle);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .db-group-actions { display: flex; gap: 2px; opacity: 0.6; }
        .db-group-item:hover .db-group-actions,
        .db-group-item:focus-within .db-group-actions { opacity: 1; }
        .db-group-actions button {
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; padding: 0;
          background: transparent; border: none; border-radius: 6px;
          color: var(--db-text-muted); font-size: 12px;
          font-family: inherit; cursor: pointer;
        }
        .db-group-actions .db-remove-btn:hover { background: rgba(220,38,38,0.1); color: var(--db-danger); }
        .db-group-actions .db-edit-btn:hover { background: var(--db-primary-ring); color: var(--db-primary); }

        /* ---------- FOOTER ---------- */
        .db-footer {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; padding-top: 14px;
          border-top: 1px solid var(--db-border-subtle); flex-wrap: wrap;
        }
        .db-preview {
          font-size: 12px; color: var(--db-text-muted);
          display: flex; align-items: center; gap: 8px;
          min-width: 0; flex: 1;
        }
        .db-preview strong {
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
          font-size: 13px; font-weight: 500; color: var(--db-text);
          background: var(--db-surface); padding: 4px 10px; border-radius: 6px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
        }
        .db-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .db-copy-btn, .db-clear-btn {
          height: 32px; padding: 0 14px;
          font-size: 12.5px; font-weight: 500; font-family: inherit;
          border-radius: 7px; cursor: pointer;
          border: 1px solid var(--db-border);
          background: var(--db-bg); color: var(--db-text-muted);
          line-height: 1;
        }
        .db-copy-btn:hover, .db-clear-btn:hover {
          color: var(--db-text);
          border-color: var(--db-border-hover);
          background: var(--db-surface);
        }
        .db-clear-btn:hover {
          color: var(--db-danger);
          border-color: rgba(220,38,38,0.3);
          background: rgba(220,38,38,0.06);
        }
        .db-accept-btn {
          height: 32px; padding: 0 18px;
          font-size: 12.5px; font-weight: 600; font-family: inherit;
          color: white; background: var(--db-primary);
          border: none; border-radius: 7px; cursor: pointer;
          box-shadow: 0 1px 2px rgba(15,23,42,0.08);
          line-height: 1;
        }
        .db-accept-btn:hover { background: var(--db-primary-hover); box-shadow: 0 2px 4px rgba(15,23,42,0.12); }

        /* ---------- ANIMATIONS ---------- */
        @keyframes db-popup-in {
          from { opacity: 0; transform: translateY(-6px) scale(0.985); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* ---------- RESPONSIVE ---------- */
        @media (max-width: 760px) {
          .db-form { grid-template-columns: 1fr 1fr; gap: 14px; }
          .db-col-rules { grid-column: 1 / -1; }
          .db-col-actions { grid-column: 1 / -1; }
        }
        @media (max-width: 520px) {
          .db-form { grid-template-columns: 1fr; }
          .db-col-rules, .db-col-actions { grid-column: 1; }
          .db-qty, .db-die-type, .db-bonus, .db-rule-selector,
          .db-rule-mod, .db-limit-op, .db-limit-val { font-size: 16px; }
          .db-help-item { grid-template-columns: 1fr; gap: 4px; }
          .db-help-example { justify-self: start; }
          .db-preview { flex-direction: column; align-items: flex-start; gap: 4px; }
        }

        /* ---------- REDUCED MOTION ---------- */
        @media (prefers-reduced-motion: reduce) {
          .die-builder *, .die-builder-popup * {
            animation-duration: 0.01ms !important;
            transition-duration: 0.01ms !important;
          }
        }

        /* ---------- INLINE VALIDATION ---------- */
        .db-form-error-banner {
          grid-column: 1 / -1;
          padding: 9px 12px;
          margin: -2px 0 4px;
          font-size: 12px;
          line-height: 1.45;
          color: var(--db-danger);
          background: color-mix(in srgb, var(--db-danger) 8%, transparent);
          border: 1px solid color-mix(in srgb, var(--db-danger) 28%, transparent);
          border-radius: 7px;
        }
        .db-form-error-banner > div + div {
          margin-top: 3px;
        }
        .db-input-error {
          border-color: var(--db-danger) !important;
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--db-danger) 14%, transparent) !important;
        }
      `;

      const popup = isPopup ? `
        .die-builder-popup {
          position: fixed;
          z-index: 9999;
          box-sizing: border-box;
          animation: db-popup-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
          font-family: var(--db-font);
          color: var(--db-text);
          /* No background, border, shadow, padding or overflow —
             the visual "card" lives on the flip faces so it rotates
             with them. This is now a transparent positioning wrapper. */
        }
        .die-builder-popup .die-builder {
          padding: 0;
          border: none;
          background: transparent;
          border-radius: 0;
        }

        /* ---------- FLIP CARD ---------- */
        .db-flip-container {
          perspective: 1400px;
          width: 100%;
        }
        .db-flip-inner {
          position: relative;
          transform-style: preserve-3d;
          height: 0;
          transition:
            transform var(--db-flip-duration) cubic-bezier(0.4, 0.0, 0.2, 1),
            height var(--db-flip-duration) cubic-bezier(0.4, 0.0, 0.2, 1);
        }
        .db-flip-inner[data-flipped="true"] { transform: rotateY(180deg); }
                .db-flip-face {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          backface-visibility: hidden;
          -webkit-backface-visibility: hidden;
          /* Pure transform layer — no background, no border, no radius,
             no padding, no shadow. Just holds the 3D rotation. */
        }
        .db-flip-face.db-flip-back { transform: rotateY(180deg); }
        .db-flip-face.db-flip-back .db-help-content { padding-top: 4px; }

        /* The visual card — plain 2D element inside the transformed face,
           so border-radius clips reliably in every browser. */
        .db-face-card {
          padding: 22px;
          background: var(--db-bg);
          border: 1px solid var(--db-border-subtle);
          border-radius: 14px;
          box-shadow:
            0 0 0 1px rgba(15, 23, 42, 0.02),
            0 12px 24px -6px var(--db-shadow),
            0 32px 64px -16px var(--db-shadow);
          max-height: 80vh;
          overflow: hidden;
          display: flex;
          transform: translateZ(0);
          contain: paint;
          flex-direction: column;
          box-sizing: border-box;
        }

        /* Scroll layer */
        .db-face-content {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-gutter: stable;
          scrollbar-width: thin;
          scrollbar-color: var(--db-border) transparent;
        }
        .db-face-content::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .db-face-content::-webkit-scrollbar-track {
          background: transparent;
        }
        .db-face-content::-webkit-scrollbar-thumb {
          background: var(--db-border);
          border-radius: 4px;
          border: 2px solid transparent;
          background-clip: content-box;
        }
        .db-face-content::-webkit-scrollbar-thumb:hover {
          background: var(--db-border-hover);
          background-clip: content-box;
          border: 2px solid transparent;
        }

        @media (max-width: 760px) {
          .die-builder-popup {
            width: 95vw !important;
            left: 2.5vw !important;
          }
          .db-face-card {
            padding: 18px;
            border-radius: 12px;
          }
        }
      ` : '';

      return base + popup;
    }

    // ============================================================
    // 5q. DESTROY
    // ============================================================
    destroy() {
      this._eventListeners.forEach(({ el, event, handler }) => {
        el.removeEventListener(event, handler);
      });
      this._eventListeners = [];
      clearTimeout(this._clickingInsideTimer);
      clearTimeout(this._validateDebounce);
      if (this._focusTrapHandler) {
        document.removeEventListener('keydown', this._focusTrapHandler);
        this._focusTrapHandler = null;
      }
      if (this._faceResizeObserver) {
        this._faceResizeObserver.disconnect();
        this._faceResizeObserver = null;
      }
      this._destroyTriggerButton();
      if (this.container) this.container.innerHTML = '';
      if (this.popupContainer) {
        this.popupContainer.remove();
        this.popupContainer = null;
      }
      this.groups = [];
      return this;
    }
  }

  return DieBuilder;
}));