// die-builder.js - Full Edition with Multi-Rule, Help Panel, Popup, and Input Parsing
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
  // 1. RULES DEFINITION (with full metadata)
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
      notation: (g, mod, limitOp, limitVal) => {
        const op = (limitOp === '=') ? '' : limitOp;
        return `!${op}${limitVal}`;
      },
      description: 'When a die rolls the trigger value, add another die (explosion).'
    },
    explodeCompounding: {
      id: 'explodeCompounding', label: 'Explode (Compounding)', category: 'explosion',
      needsModifier: false, needsLimit: true, limitMin: 1,
      notation: (g, mod, limitOp, limitVal) => {
        const op = (limitOp === '=') ? '' : limitOp;
        return `!!${op}${limitVal}`;
      },
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
    filter:  { label: '📊 Keep/Drop', order: 1 },
    explosion: { label: '💥 Explosions', order: 2 },
    reroll: { label: '🔄 Rerolls', order: 3 },
    sort: { label: '📋 Sorting', order: 4 },
    critical: { label: '🎯 Criticals', order: 5 },
    success: { label: '✅ Success Counting', order: 6 },
    none: { label: '⚪ No Rule', order: 7 }
  };

  // ============================================================
  // 2. DEFAULTS & CONFIGURATION
  // ============================================================
  const DEFAULTS = {
    dieTypes: ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'],
    comparisonOps: ['=', '>', '<'],
    theme: {
      mode: 'light',
      colors: {
        primary: '#4a90d9',
        primaryHover: '#3a7bc8',
        success: '#27ae60',
        danger: '#e74c3c',
        warning: '#f39c12',
        background: '#ffffff',
        surface: '#f5f5f5',
        surfaceHover: '#e9e9e9',
        text: '#333333',
        textMuted: '#888888',
        border: '#dddddd',
        shadow: 'rgba(0,0,0,0.15)'
      }
    },
    labels: {
      title: '🎲 Dice Notation Builder',
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
      glossaryTitle: '📖 Notation Glossary',
      glossaryClose: 'Close Glossary'
    },
    callbacks: {
      onChange: null,
      onGroupAdd: null,
      onGroupRemove: null,
      onClear: null,
      onAccept: null,
      onClose: null,
      onError: null
    },
    features: {
      allowManual: true,
      showPreview: true,
      showHelp: true,
      autoValidate: true,
      showCategories: true
    },
    popup: {
      enabled: false,
      targetInput: null,
      width: '80vw',
      maxHeight: '80vh',
      closeOnOutsideClick: true,
      closeOnEscape: true
    },
    validator: null
  };

  // ============================================================
  // 3. HELPERS
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
    try {
      if (fn && typeof fn === 'function') return fn(...args);
    } catch (e) {
      // ignore
    }
  }

  // ============================================================
  // 4. MAIN CLASS
  // ============================================================
  class DieBuilder {
    constructor(config = {}) {
      this.config = deepMerge(DEFAULTS, config);
      this.container = null;
      this.popupContainer = null;
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

      if (this.config.callbacks.onNotationChange && !this.config.callbacks.onChange) {
        this.config.callbacks.onChange = this.config.callbacks.onNotationChange;
      }
    }

    // ============================================================
    // 4a. CONFIGURATION API
    // ============================================================
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
        this._renderGroups();
        this._updateOutput();
      }
      return this;
    }

    // ============================================================
    // 4b. INIT / ATTACH
    // ============================================================
    init(element, options = {}) {
      if (Object.keys(options).length > 0) {
        this.config = deepMerge(this.config, options);
      }
      return this.inject(element);
    }

    inject(selector) {
      this.container = getElement(selector);
      if (!this.container) {
        this._handleError(new Error('Container not found'));
        return this;
      }
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
      if (!this.targetInput) {
        this._handleError(new Error('Target input not found'));
        return this;
      }

      this.config.popup.enabled = true;
      this._isPopup = true;

      this.popupContainer = document.createElement('div');
      this.popupContainer.className = 'die-builder-popup';
      this.popupContainer.style.display = 'none';
      document.body.appendChild(this.popupContainer);

      // Track mousedown inside popup so blur/outside-click don't close it
      // while we're mid-interaction (buttons get detached on re-render).
      this.popupContainer.addEventListener('mousedown', () => {
        this._clickingInside = true;
        clearTimeout(this._clickingInsideTimer);
        this._clickingInsideTimer = setTimeout(() => {
          this._clickingInside = false;
        }, 400);
      });

      this._renderPopup();
      this._bindPopupEvents();
      this._bindCommonEvents();
      this._bindFormEvents();

      // Parse any pre-existing notation already in the input
      this._lastInputValue = (this.targetInput.value || '').trim();
      if (this._lastInputValue) {
        this._parseAndSetNotation(this._lastInputValue);
      }

      this._renderGroups();
      this._updateOutput();

      this.targetInput.addEventListener('focus', () => this.show());
      this.targetInput.addEventListener('blur', () => {
        setTimeout(() => {
          if (this._clickingInside) return;
          if (this._isVisible && !this.popupContainer.contains(document.activeElement)) {
            this.hide(false);
          }
        }, 150);
      });

      if (this.config.popup.closeOnOutsideClick) {
        document.addEventListener('click', (e) => {
          if (this._clickingInside) return;
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

      window.addEventListener('scroll', () => this._positionPopup(), true);
      window.addEventListener('resize', () => this._positionPopup());

      return this;
    }

    // ============================================================
    // 4c. POPUP CONTROL
    // ============================================================
    show() {
      if (!this._isPopup) return;

      // Sync from the input if it has been changed externally since we last saw it.
      const currentInput = (this.targetInput.value || '').trim();
      if (currentInput !== (this._lastInputValue || '')) {
        this._lastInputValue = currentInput;
        this._parseAndSetNotation(currentInput);
        this._refreshForm();
      }

      this._isVisible = true;
      this.popupContainer.style.display = 'block';
      this._positionPopup();
      const firstInput = this.popupContainer.querySelector('.db-qty');
      if (firstInput) setTimeout(() => firstInput.focus(), 50);
      this._updateOutput();
    }

    hide(accept = false) {
      if (!this._isPopup) return;
      this._isVisible = false;
      this.popupContainer.style.display = 'none';
      if (accept) {
        const notation = this.getNotation();
        const validation = this._validateNotation(notation);
        if (!validation.valid) {
          this._handleError(new Error(validation.message || 'Invalid notation'));
          this._isVisible = true;
          this.popupContainer.style.display = 'block';
          return;
        }
        this.targetInput.value = notation;
        this._lastInputValue = notation;
        this.targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        this.targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        safeCall(this.config.callbacks.onAccept, notation, this.groups);
      } else {
        safeCall(this.config.callbacks.onClose);
      }
    }

    // ============================================================
    // 4d. NOTATION OPERATIONS
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
      return this;
    }

    removeGroup(index) {
      if (index >= 0 && index < this.groups.length) {
        const removed = this.groups.splice(index, 1)[0];
        this._renderGroups();
        this._updateOutput();
        this._triggerChange('onGroupRemove', removed);
      }
      return this;
    }

    // ============================================================
    // 4e. HELP PANEL
    // ============================================================
    toggleHelp() {
      this._helpVisible = !this._helpVisible;
      const container = this._isPopup ? this.popupContainer : this.container;
      const panel = container.querySelector('.db-help-panel');
      if (panel) {
        panel.style.display = this._helpVisible ? 'block' : 'none';
        if (this._helpVisible) this._populateHelp(container);
      }
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
    // 4f. ERROR HANDLING
    // ============================================================
    _handleError(error) {
      this._error = error;
      safeCall(this.config.callbacks.onError, error);
      console.error('[DieBuilder]', error);
    }

    _validateNotation(notation) {
      if (this.config.validator && typeof this.config.validator === 'function') {
        try {
          const result = this.config.validator(notation);
          if (typeof result === 'string') return { valid: false, message: result };
          if (result === false) return { valid: false, message: 'Invalid notation' };
          return { valid: true };
        } catch (e) {
          return { valid: false, message: e.message };
        }
      }
      if (!notation || notation.trim() === '') {
        return { valid: false, message: 'Notation is empty' };
      }
      for (const g of this.groups) {
        if (!this._isGroupValid(g)) {
          return { valid: false, message: `Group "${g.id}" is invalid` };
        }
      }
      return { valid: true };
    }

    // ============================================================
    // 4g. INTERNAL RENDER METHODS
    // ============================================================
    _renderStandalone() {
      this.container.innerHTML = this._buildHTML(false);
      this._applyStyles(false);
    }

    _renderPopup() {
      this.popupContainer.innerHTML = this._buildHTML(true);
      this._applyStyles(true);
    }

    _refreshForm() {
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;
      const builderArea = container.querySelector('#db-group-builder');
      if (builderArea) builderArea.innerHTML = this._renderGroupForm();
      this._bindFormEvents();
      this._renderGroups();
      this._updateOutput();
    }

    _buildHTML(isPopup) {
      const { labels, features } = this.config;
      const closeBtn = isPopup ? `<button class="db-close-btn" id="db-close-btn">✕</button>` : '';
      const acceptBtn = isPopup ? `<button class="db-accept-btn" id="db-accept-btn">✅ ${labels.accept}</button>` : '';
      const helpBtn = `<button class="db-help-btn" id="db-help-btn" title="${labels.help}">📖</button>`;
      const manual = features.allowManual && !isPopup ? `
        <div class="db-manual">
          <input type="text" id="db-manual-input" placeholder="${labels.manualPlaceholder}" />
          <button id="db-manual-apply">${labels.apply}</button>
        </div>
      ` : '';

      return `
        <div class="die-builder" data-theme="${this.config.theme.mode}">
          <div class="db-header">
            <h3>${labels.title}</h3>
            <div class="db-header-actions">
              ${helpBtn}
              ${closeBtn}
            </div>
          </div>
          ${manual}
          <div class="db-help-panel" style="display:none;">
            <div class="db-help-header">
              <span>${labels.glossaryTitle}</span>
              <button class="db-help-close" id="db-help-close">${labels.glossaryClose}</button>
            </div>
            <div class="db-help-content"></div>
          </div>
          <div class="db-group-builder" id="db-group-builder">
            ${this._renderGroupForm()}
          </div>
          <div class="db-groups-header">
            <span>Groups (${this.groups.length})</span>
          </div>
          <div class="db-groups" id="db-groups-list">
            <div class="db-empty">${labels.noGroups}</div>
          </div>
          <div class="db-footer">
            ${features.showPreview ? `
              <span class="db-preview">${labels.notation} <strong id="db-preview-text">—</strong></span>
            ` : ''}
            <div class="db-actions">
              <button class="db-clear-btn" id="db-clear-btn">🗑️ ${labels.clearAll}</button>
              <button class="db-copy-btn" id="db-copy-btn">📋 ${labels.copy}</button>
              ${acceptBtn}
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
          <div class="db-rule-entry" data-rule-index="${idx}">
            <div class="db-rule-fields">
              <select class="db-rule-selector" data-rule-idx="${idx}">
                <option value="">Select rule...</option>
                ${Object.entries(categorizedRules).map(([cat, rules]) => `
                  <optgroup label="${RULE_CATEGORIES[cat]?.label || cat}">
                    ${rules.map(r => `
                      <option value="${r.id}" ${ruleEntry.id === r.id ? 'selected' : ''}>
                        ${r.label}
                      </option>
                    `).join('')}
                  </optgroup>
                `).join('')}
              </select>
              ${this._renderRuleModifiers(ruleEntry, g, idx)}
            </div>
            ${rulesArray.length > 1 ? `<button class="db-rule-remove" data-rule-idx="${idx}">✕</button>` : ''}
          </div>
        `;
      });

      return `
        <div class="db-form" data-group-id="${g.id || 'new'}">
          <div class="db-col db-col-base">
            <label>${labels.baseDie}</label>
            <div class="db-field">
              <input type="number" class="db-qty" value="${g.quantity || 1}" min="1" max="100" />
              <select class="db-die-type">
                ${this.config.dieTypes.map(d => 
                  `<option value="${d}" ${g.dieType === d ? 'selected' : ''}>${d}</option>`
                ).join('')}
              </select>
            </div>
            ${features.showHelp ? `<div class="db-help">${this.config.helpText?.base || ''}</div>` : ''}
          </div>

          <div class="db-col db-col-rules">
            <label>${labels.rule}</label>
            <div class="db-rules-container">
              ${ruleEntries}
              <button class="db-add-rule-btn">➕ ${labels.addRule}</button>
            </div>
            ${features.showHelp ? `<div class="db-help">${this.config.helpText?.rule || ''}</div>` : ''}
          </div>

          <div class="db-col db-col-bonus">
            <label>${labels.bonus}</label>
            <div class="db-field">
              <input type="number" class="db-bonus" value="${g.bonus || 0}" step="1" />
            </div>
            ${features.showHelp ? `<div class="db-help">${this.config.helpText?.bonus || ''}</div>` : ''}
          </div>

          <div class="db-col db-col-actions">
            <button class="db-add-btn">${isEdit ? labels.updateGroup : '➕ ' + labels.addGroup}</button>
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
                 value="${val}" min="${ruleObj.modifierMin || 1}" max="${max || 100}" />
        `;
      }
      if (ruleObj.needsLimit) {
        const dieMax = parseInt(group.dieType.replace('d', ''));
        const min = ruleObj.limitMin || 1;
        const currentVal = (ruleEntry.limitValue && ruleEntry.limitValue > 0)
          ? ruleEntry.limitValue
          : dieMax;
        html += `
          <select class="db-limit-op" data-rule-idx="${idx}">
            ${this.config.comparisonOps.map(op => 
              `<option value="${op}" ${ruleEntry.limitOperator === op ? 'selected' : ''}>${op}</option>`
            ).join('')}
          </select>
          <input type="number" class="db-limit-val" data-rule-idx="${idx}" 
                 value="${currentVal}" min="${min}" max="${dieMax}" />
        `;
      }
      return html || `<span class="db-no-mod">${this.config.labels.noModifiers}</span>`;
    }

    _renderGroups() {
      const container = this._isPopup ? this.popupContainer : this.container;
      const list = container.querySelector('#db-groups-list');
      if (!list) return;

      if (this.groups.length === 0) {
        list.innerHTML = `<div class="db-empty">${this.config.labels.noGroups}</div>`;
        return;
      }

      list.innerHTML = this.groups.map((g, index) => {
        const valid = this._isGroupValid(g);
        const notation = valid ? this._buildGroupNotation(g) : '⚠️ Invalid';
        const rulesStr = g.rules.map(r => RULE_DEFS[r.id]?.label || r.id).join(', ');
        return `
          <div class="db-group-item ${valid ? '' : 'invalid'}" data-index="${index}">
            <div class="db-group-info">
              <span class="db-group-notation">${notation}</span>
              <span class="db-group-desc">${rulesStr}</span>
            </div>
            <div class="db-group-actions">
              <button class="db-edit-btn" data-index="${index}">✏️</button>
              <button class="db-remove-btn" data-index="${index}">✕</button>
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
      for (const cat in categorized) {
        categorized[cat].sort((a, b) => {
          const orderA = RULE_CATEGORIES[a.category]?.order || 99;
          const orderB = RULE_CATEGORIES[b.category]?.order || 99;
          return orderA - orderB;
        });
      }
      return categorized;
    }

    // ============================================================
    // 4h. EVENT BINDING
    // ============================================================
    _bindCommonEvents() {
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;

      const manualInput = container.querySelector('#db-manual-input');
      const manualApply = container.querySelector('#db-manual-apply');
      if (manualApply && manualInput) {
        manualApply.addEventListener('click', () => {
          if (manualInput.value) this.setNotation(manualInput.value);
        });
        manualInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && manualInput.value) this.setNotation(manualInput.value);
        });
      }

      const clearBtn = container.querySelector('#db-clear-btn');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => this.clear());
      }

      const copyBtn = container.querySelector('#db-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          const notation = this.getNotation();
          if (notation) {
            navigator.clipboard?.writeText(notation).then(() => {
              copyBtn.textContent = '✅ ' + this.config.labels.copied;
              setTimeout(() => copyBtn.textContent = '📋 ' + this.config.labels.copy, 2000);
            }).catch(() => {
              const textarea = document.createElement('textarea');
              textarea.value = notation;
              document.body.appendChild(textarea);
              textarea.select();
              document.execCommand('copy');
              textarea.remove();
            });
          }
        });
      }

      const helpBtn = container.querySelector('#db-help-btn');
      if (helpBtn) {
        helpBtn.addEventListener('click', () => this.toggleHelp());
      }
      const helpClose = container.querySelector('#db-help-close');
      if (helpClose) {
        helpClose.addEventListener('click', () => {
          this._helpVisible = false;
          const panel = container.querySelector('.db-help-panel');
          if (panel) panel.style.display = 'none';
        });
      }

      const groupsList = container.querySelector('#db-groups-list');
      if (groupsList) {
        groupsList.addEventListener('click', (e) => {
          const removeBtn = e.target.closest('.db-remove-btn');
          if (removeBtn) {
            const index = parseInt(removeBtn.dataset.index);
            this.removeGroup(index);
          }
          const editBtn = e.target.closest('.db-edit-btn');
          if (editBtn) {
            const index = parseInt(editBtn.dataset.index);
            const group = this.groups[index];
            const builder = container.querySelector('#db-group-builder');
            builder.innerHTML = this._renderGroupForm(group);
            this._bindFormEvents();
            this.groups.splice(index, 1);
            this._renderGroups();
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
              if (index !== -1) {
                group.id = editId;
                this.groups[index] = group;
              }
            } else {
              group.id = `g${++this.groupCounter}`;
              this.groups.push(group);
            }
            builderArea.innerHTML = this._renderGroupForm();
            this._bindFormEvents();
            this._renderGroups();
            this._updateOutput();
            this._triggerChange('onGroupAdd', group);
          }
        });

        builderArea.addEventListener('click', (e) => {
          const addRuleBtn = e.target.closest('.db-add-rule-btn');
          if (addRuleBtn) {
            const form = addRuleBtn.closest('.db-form');
            const group = this._collectFormData(form);
            if (!group.rules) group.rules = [];
            group.rules.push({ id: 'none', ruleModifier: 1, limitOperator: '=', limitValue: 1 });
            const newForm = this._renderGroupForm(group);
            const builder = form.closest('#db-group-builder');
            builder.innerHTML = newForm;
            this._bindFormEvents();
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
              const newForm = this._renderGroupForm(group);
              const builder = form.closest('#db-group-builder');
              builder.innerHTML = newForm;
              this._bindFormEvents();
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
              const newForm = this._renderGroupForm(group);
              const builder = form.closest('#db-group-builder');
              builder.innerHTML = newForm;
              this._bindFormEvents();
            }
          }
        });
      }

      container.addEventListener('input', (e) => {
        if (this.config.features.autoValidate) {
          const form = e.target.closest('.db-form');
          if (form) {
            const group = this._collectFormData(form);
            if (this._isGroupValid(group)) {
              const preview = this._buildGroupNotation(group);
              const previewEl = container.querySelector('#db-preview-text');
              if (previewEl) previewEl.textContent = preview;
            }
          }
        }
      });
    }

    _bindPopupEvents() {
      const container = this.popupContainer;
      const closeBtn = container.querySelector('#db-close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hide(false));
      }
      const acceptBtn = container.querySelector('#db-accept-btn');
      if (acceptBtn) {
        acceptBtn.addEventListener('click', () => this.hide(true));
      }
    }

    _bindFormEvents() {
      const container = this._isPopup ? this.popupContainer : this.container;
      if (!container) return;
      const qtyInputs = container.querySelectorAll('.db-qty');
      qtyInputs.forEach(qty => {
        qty.addEventListener('change', () => {
          const form = qty.closest('.db-form');
          const qtyVal = parseInt(qty.value) || 1;
          const modInputs = form.querySelectorAll('.db-rule-mod');
          modInputs.forEach(mod => {
            const max = qtyVal - 1;
            mod.max = max;
            if (parseInt(mod.value) > max) mod.value = max;
          });
        });
      });
    }

    // ============================================================
    // 4i. DATA COLLECTION & VALIDATION
    // ============================================================
    _collectFormData(form) {
      const qty = parseInt(form.querySelector('.db-qty')?.value) || 1;
      const dieType = form.querySelector('.db-die-type')?.value || 'd6';
      const bonus = parseInt(form.querySelector('.db-bonus')?.value) || 0;
      const id = form.dataset.groupId || null;

      const rules = [];
      const ruleSelectors = form.querySelectorAll('.db-rule-selector');

      ruleSelectors.forEach((sel) => {
        const idx = parseInt(sel.dataset.ruleIdx);
        const ruleModInput = form.querySelector(`.db-rule-mod[data-rule-idx="${idx}"]`);
        const limitOpInput = form.querySelector(`.db-limit-op[data-rule-idx="${idx}"]`);
        const limitValInput= form.querySelector(`.db-limit-val[data-rule-idx="${idx}"]`);
        rules.push({
          id: sel.value || 'none',
          ruleModifier: ruleModInput ? parseInt(ruleModInput.value) : 1,
          limitOperator: limitOpInput ? limitOpInput.value : '=',
          limitValue:   limitValInput ? parseInt(limitValInput.value) : 1
        });
      });

      return { id, quantity: qty, dieType, rules, bonus };
    }

    _defaultGroup() {
      return {
        id: null,
        quantity: 1,
        dieType: 'd6',
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
      if (group.bonus) {
        parts.push(`${group.bonus > 0 ? '+' : ''}${group.bonus}`);
      }
      return parts.join('');
    }

    // ============================================================
    // 4j. PARSING
    //
    // Iterative parser that:
    //  - recognises `NdN` group starts anywhere in the string
    //    (so `kh18d6` is treated as `kh1` + `8d6`)
    //  - accumulates pure bonuses (`+3`, `-2`, `5`)
    //  - silently skips unparseable chars to avoid infinite loops
    // ============================================================
    _parseAndSetNotation(notation) {
      this.groups = [];
      this.groupCounter = 0;
      if (!notation || notation.trim() === '') return;

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
      let safety = 0;
      const MAX_ITER = 300;

      while (remaining.length > 0 && safety++ < MAX_ITER) {
        // Skip leading whitespace and + separators
        const skip = remaining.match(/^[\s+]+/);
        if (skip) {
          remaining = remaining.slice(skip[0].length);
          if (!remaining) break;
        }

        // Try to match a die group start
        const dieMatch = remaining.match(/^(\d+)d(\d+)/);
        if (dieMatch) {
          const group = this._defaultGroup();
          group.id = `g${++this.groupCounter}`;
          group.quantity = parseInt(dieMatch[1]);
          group.dieType = `d${dieMatch[2]}`;
          remaining = remaining.slice(dieMatch[0].length);

          // Parse rules greedily until nothing more matches at position 0
          const rules = [];
          let rulesRunning = true;
          while (rulesRunning && remaining.length > 0) {
            rulesRunning = false;
            for (const pattern of rulePatterns) {
              const m = remaining.match(pattern.regex);
              if (m && m.index === 0) {
                const ruleEntry = { id: pattern.id, ruleModifier: 1, limitOperator: '=', limitValue: 1 };
                if (pattern.id === 'keep' || pattern.id === 'keepLowest' ||
                    pattern.id === 'dropHighest' || pattern.id === 'dropLowest') {
                  ruleEntry.ruleModifier = parseInt(m[1]);
                } else if (pattern.id === 'explode' || pattern.id === 'explodeCompounding') {
                  ruleEntry.limitOperator = m[1] || '=';
                  ruleEntry.limitValue = parseInt(m[2]);
                } else if (pattern.id === 'reroll') {
                  ruleEntry.ruleModifier = parseInt(m[1]) || 1;
                  ruleEntry.limitOperator = m[2];
                  ruleEntry.limitValue = parseInt(m[3]);
                } else if (pattern.id === 'rerollOnce') {
                  ruleEntry.limitOperator = m[1];
                  ruleEntry.limitValue = parseInt(m[2]);
                } else if (pattern.id === 'criticalSuccess' || pattern.id === 'criticalFailure') {
                  ruleEntry.limitOperator = m[1];
                  ruleEntry.limitValue = parseInt(m[2]);
                } else if (pattern.id === 'targetNumber' || pattern.id === 'failures') {
                  ruleEntry.ruleModifier = parseInt(m[1]);
                }
                rules.push(ruleEntry);
                remaining = remaining.slice(m[0].length);
                rulesRunning = true;
                break;
              }
            }
          }

          // Optional trailing bonus like '+5' or '-3' — only if not followed by 'd'
          const bonusMatch = remaining.match(/^([+-]\d+)(?![d\d])/);
          if (bonusMatch) {
            group.bonus = parseInt(bonusMatch[1]);
            remaining = remaining.slice(bonusMatch[0].length);
          }

          group.rules = rules.length > 0
            ? rules
            : [{ id: 'none', ruleModifier: 1, limitOperator: '=', limitValue: 1 }];

          if (this._isGroupValid(group)) {
            this.groups.push(group);
          }
          continue;
        }

        // Try a pure bonus (not followed by 'd')
        const pureBonus = remaining.match(/^([+-]?\d+)(?![d\d])/);
        if (pureBonus) {
          bonusAccumulator += parseInt(pureBonus[1]);
          remaining = remaining.slice(pureBonus[0].length);
          continue;
        }

        // Nothing matched — skip one character to guarantee progress
        remaining = remaining.slice(1);
      }

      // Apply any accumulated bonus to the last group
      if (bonusAccumulator !== 0 && this.groups.length > 0) {
        const last = this.groups[this.groups.length - 1];
        last.bonus = (last.bonus || 0) + bonusAccumulator;
      } else if (bonusAccumulator !== 0) {
        const g = this._defaultGroup();
        g.id = `g${++this.groupCounter}`;
        g.bonus = bonusAccumulator;
        this.groups.push(g);
      }
    }

    // ============================================================
    // 4k. UI UPDATES
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
      if (eventType && callbacks[eventType]) {
        safeCall(callbacks[eventType], notation, this.groups, data);
      }
    }

    // ============================================================
    // 4l. POPUP POSITIONING
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
      let top = rect.bottom + 5;
      if (top + popupH > winH - 10) {
        top = rect.top - popupH - 5;
      }
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    }

    // ============================================================
    // 4m. STYLES
    // ============================================================
    _applyStyles(isPopup) {
      const target = isPopup ? this.popupContainer : this.container;
      const style = document.createElement('style');
      style.textContent = this._getStyles(isPopup);
      target.appendChild(style);
    }

    _getStyles(isPopup) {
      const base = `
        .die-builder {
          font-family: var(--db-font, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
          padding: 16px;
          background: var(--db-bg, #fff);
          color: var(--db-text, #333);
          border-radius: 8px;
          max-width: 100%;
          box-sizing: border-box;
        }
        .db-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          flex-wrap: wrap;
          gap: 8px;
        }
        .db-header h3 { margin: 0; font-size: 1.2rem; }
        .db-header-actions { display: flex; gap: 6px; align-items: center; }
        .db-help-btn, .db-close-btn {
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: var(--db-text-muted, #888);
          padding: 0 4px;
        }
        .db-help-btn:hover { color: var(--db-primary, #4a90d9); }
        .db-close-btn:hover { color: var(--db-danger, #e74c3c); }
        .db-manual { display: flex; gap: 8px; margin-bottom: 12px; }
        .db-manual input {
          flex: 1;
          padding: 6px 12px;
          border: 1px solid var(--db-border, #ddd);
          border-radius: 4px;
          background: var(--db-input-bg, #fff);
          color: var(--db-text, #333);
        }
        .db-manual button {
          padding: 6px 14px;
          border: none;
          border-radius: 4px;
          background: var(--db-primary, #4a90d9);
          color: white;
          cursor: pointer;
        }
        .db-help-panel {
          background: var(--db-surface, #f5f5f5);
          border-radius: 4px;
          padding: 12px;
          margin-bottom: 12px;
          max-height: 300px;
          overflow-y: auto;
          border: 1px solid var(--db-border, #ddd);
        }
        .db-help-header {
          display: flex;
          justify-content: space-between;
          font-weight: bold;
          margin-bottom: 8px;
        }
        .db-help-close {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--db-primary, #4a90d9);
        }
        .db-help-content { font-size: 0.9rem; }
        .db-help-category { margin-bottom: 10px; }
        .db-help-item {
          display: flex;
          gap: 12px;
          padding: 4px 0;
          border-bottom: 1px solid var(--db-border, #eee);
          flex-wrap: wrap;
        }
        .db-help-rule { font-weight: 600; min-width: 120px; }
        .db-help-desc { flex: 1; color: var(--db-text-muted, #666); }
        .db-help-example { font-family: monospace; color: var(--db-primary, #4a90d9); }
        .db-form {
          display: grid;
          grid-template-columns: 1fr 2fr 1fr 0.8fr;
          gap: 12px;
          padding: 12px;
          background: var(--db-surface, #f5f5f5);
          border-radius: 6px;
          margin-bottom: 12px;
        }
        .db-col label {
          display: block;
          font-weight: 600;
          font-size: 0.85rem;
          margin-bottom: 4px;
          color: var(--db-text, #333);
        }
        .db-field { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .db-field input, .db-field select {
          padding: 4px 8px;
          border: 1px solid var(--db-border, #ccc);
          border-radius: 4px;
          background: var(--db-input-bg, #fff);
          color: var(--db-text, #333);
          font-size: 14px;
        }
        .db-qty { width: 60px; }
        .db-die-type { width: 70px; }
        .db-bonus { width: 70px; }
        .db-rule-mod { width: 50px; }
        .db-limit-val { width: 50px; }
        .db-limit-op { width: 50px; }
        .db-rule-selector { min-width: 120px; flex: 1; }
        .db-rules-container {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .db-rule-entry {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--db-bg, #fff);
          padding: 4px 6px;
          border-radius: 4px;
          border: 1px solid var(--db-border, #ddd);
        }
        .db-rule-fields {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px;
          flex: 1;
        }
        .db-rule-remove {
          background: none;
          border: none;
          color: var(--db-danger, #e74c3c);
          cursor: pointer;
          font-size: 16px;
          padding: 0 4px;
        }
        .db-add-rule-btn {
          background: none;
          border: 1px dashed var(--db-border, #ccc);
          border-radius: 4px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 0.85rem;
          color: var(--db-text-muted, #888);
        }
        .db-add-rule-btn:hover { background: var(--db-surface-hover, #e9e9e9); }
        .db-no-mod { color: var(--db-text-muted, #999); font-size: 0.85rem; }
        .db-add-btn {
          padding: 6px 12px;
          background: var(--db-primary, #4a90d9);
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 600;
          width: 100%;
          margin-top: 4px;
        }
        .db-add-btn:hover { background: var(--db-primary-hover, #3a7bc8); }
        .db-groups-header {
          padding: 4px 0;
          font-size: 0.9rem;
          color: var(--db-text-muted, #888);
        }
        .db-groups {
          min-height: 50px;
          margin-bottom: 12px;
        }
        .db-empty {
          text-align: center;
          color: var(--db-text-muted, #999);
          padding: 16px;
        }
        .db-group-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 6px 10px;
          margin-bottom: 4px;
          background: var(--db-surface, #f9f9f9);
          border-radius: 4px;
          border-left: 3px solid var(--db-primary, #4a90d9);
        }
        .db-group-item.invalid { border-left-color: var(--db-danger, #e74c3c); opacity: 0.6; }
        .db-group-info { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; flex: 1; }
        .db-group-notation { font-family: monospace; font-weight: 600; font-size: 14px; }
        .db-group-desc { font-size: 12px; color: var(--db-text-muted, #888); }
        .db-group-actions { display: flex; gap: 4px; }
        .db-group-actions button {
          background: none;
          border: none;
          cursor: pointer;
          font-size: 16px;
          padding: 0 4px;
        }
        .db-group-actions .db-remove-btn:hover { color: var(--db-danger, #e74c3c); }
        .db-group-actions .db-edit-btn:hover { color: var(--db-primary, #4a90d9); }
        .db-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-top: 8px;
          border-top: 1px solid var(--db-border, #ddd);
          flex-wrap: wrap;
          gap: 8px;
        }
        .db-preview { font-size: 14px; }
        .db-preview strong { font-family: monospace; font-size: 16px; color: var(--db-primary, #4a90d9); }
        .db-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .db-copy-btn, .db-clear-btn, .db-accept-btn {
          padding: 4px 12px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }
        .db-copy-btn { background: var(--db-primary, #4a90d9); color: white; }
        .db-copy-btn:hover { background: var(--db-primary-hover, #3a7bc8); }
        .db-clear-btn { background: var(--db-danger, #e74c3c); color: white; }
        .db-clear-btn:hover { background: #c0392b; }
        .db-accept-btn { background: var(--db-success, #27ae60); color: white; font-weight: 600; }
        .db-accept-btn:hover { opacity: 0.9; }
        .db-help {
          font-size: 0.7rem;
          color: var(--db-text-muted, #999);
          margin-top: 2px;
          min-height: 16px;
        }
        @media (max-width: 700px) {
          .db-form { grid-template-columns: 1fr 1fr; }
          .db-col-actions { grid-column: span 2; }
          .db-field input, .db-field select { font-size: 16px; padding: 6px 8px; }
          .db-rule-selector { min-width: 80px; }
          .db-header h3 { font-size: 1rem; }
          .db-manual input { width: 100%; }
        }
        @media (max-width: 450px) {
          .db-form { grid-template-columns: 1fr; }
          .db-col-actions { grid-column: span 1; }
          .die-builder-popup { width: 95vw !important; left: 2.5vw !important; }
        }
      `;

      const popup = isPopup ? `
        .die-builder-popup {
          position: fixed;
          z-index: 9999;
          background: var(--db-bg, #fff);
          border-radius: 8px;
          box-shadow: 0 10px 40px var(--db-shadow, rgba(0,0,0,0.15));
          border: 1px solid var(--db-border, #ddd);
          padding: 12px;
          max-height: 80vh;
          overflow-y: auto;
          width: 80vw;
          box-sizing: border-box;
        }
        .die-builder-popup .die-builder {
          border: none;
          padding: 0;
          background: transparent;
        }
      ` : '';

      return base + popup;
    }

    // ============================================================
    // 4n. DESTROY
    // ============================================================
    destroy() {
      this._eventListeners.forEach(({ el, event, handler }) => {
        el.removeEventListener(event, handler);
      });
      this._eventListeners = [];
      clearTimeout(this._clickingInsideTimer);
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