# Dice Toolkit

Two small, dependency-light JavaScript libraries that share one notation
format:

- **[DieBuilder](#-diebuilder)** — an embeddable UI for building and
  validating RPG dice notation strings.
- **[DICE.js](#-dice-roller-dicejs)** — a 3D physics roller that evaluates
  and animates those same notation strings.

`DieBuilder` produces notation; `DICE.js` consumes it. Use either alone, or wire them together with about ten lines of glue (see
[Using them together](#using-them-together)).

```js
// One pipeline, two libraries.
const builder = new DieBuilder({ /* ... */ });
const box     = new DICE.dice_box(document.getElementById('tray'));

builder.attachTo('#notation-input');
builder.setConfig({
  callbacks: {
    onAccept: (notation) => {
      box.setDice(notation);
      box.roll();
    }
  }
});
```
---
## Table of contents

- [DieBuilder](#-diebuilder)
  - [Features](#diebuilder-features)
  - [Dependencies](#diebuilder-dependencies)
  - [Quick start — standalone](#quick-start--standalone)
  - [Quick start — popup on an input](#quick-start--popup-on-an-input)
  - [Rule reference](#rule-reference)
  - [API reference](#diebuilder-api-reference)
  - [Configuration reference](#diebuilder-configuration-reference)
  - [Theming](#theming)
  - [Validation](#validation)
  - [Examples](#diebuilder-examples)
  - [Accessibility](#accessibility)
  - [Browser support](#diebuilder-browser-support)
- [Dice Roller (DICE.js)](#-dice-roller-dicejs)
    - [Features](#features)
    - [Dependencies](#dependencies)
    - [Quick start](#quick-start)
    - [Dice notation reference](#dice-notation-reference)
    - [API reference](#api-reference)
    - [Configuration reference](#configuration-reference)   
    - [Result object reference](#result-object-reference)
    - [Examples](#examples)
    - [Advanced topics](#advanced-topics)
    - [Browser support and mobile notes](#browser-support-and-mobile-notes)

- [Shared notation reference](#shared-notation-reference)
- [Using them together](#using-them-together)
- [License](#license)
___
# DieBuilder

A dependency-free, embeddable UI for building and validating RPG dice
notation. Ships as a single ES5-compatible file that works as a CommonJS
module, AMD module, or plain `<script>` global.

```html
<script src="die-builder.js"></script>
<script>
  const builder = new DieBuilder();
  builder.inject('#builder');
</script>
```
## DieBuilder features

- **Complete rule set** — keep, drop, explode, compounding, penetrating,
  reroll, reroll-once, sort, criticals, target numbers, failures.
- **Two modes** — a standalone panel, or a popup attached to any `<input>`.
- **Live notation preview** — the output string updates as you edit.
- **Inline validation** — field-level highlighting and per-group banners,
  with a public `validate()` API for programmatic use.
- **Auto-parsing** — existing notation in the target input is parsed back
  into groups on open, so the user edits what they typed.
- **Theming** — a full palette system with light and dark presets, and
  per-instance colour overrides.
- **i18n-ready** — every UI string is overridable through `config.labels`.
- **No dependencies** — no runtime deps, no build step, no external CSS.
- **Accessible** — keyboard-operable, focus-trapped popup, ARIA labels
  throughout, `inert`-based flip cards, respect for `prefers-reduced-motion`.
- **Framework-agnostic** — plain DOM; safe to mount inside a Vue, React or
  Svelte component's `onMount` / `useEffect`.

## DieBuilder dependencies

None. DieBuilder is a self-contained IIFE. If you plan to roll the notation
it produces, you'll additionally want the DICE.js dependencies (teal.js,
three.js, cannon.js) — see the [DICE.js section](#-dice-roller-dicejs).

## Quick start — standalone

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    #builder { max-width: 720px; margin: 2rem auto; }
  </style>
</head>
<body>
  <div id="builder"></div>

  <script src="die-builder.js"></script>
  <script>
    const builder = new DieBuilder({
      theme: { mode: 'light' },
      callbacks: {
        onChange: (notation, groups) => {
          console.log('Notation is now:', notation);
        }
      }
    });

    builder.inject('#builder');
  </script>
</body>
</html>
```

You get an inline panel with a manual input field, an editable group form,
a live notation preview, and Copy / Clear buttons.

## Quick start — popup on an input

```html
<input id="notation-input" type="text" placeholder="1d20 + 5" />

<script src="die-builder.js"></script>
<script>
  const builder = new DieBuilder();

  builder.attachTo('#notation-input', {
    popup: {
      trigger: 'both',                // 'focus' | 'button' | 'both'
      width: '640px',
      maxHeight: '70vh',
      closeOnOutsideClick: true,
      closeOnEscape: true
    },
    callbacks: {
      onAccept: (notation) => console.log('Accepted:', notation),
      onClose:  () => console.log('Dismissed')
    }
  });
</script>
```

`trigger: 'both'` gives you a floating chevron button *and* a dialog that
opens on focus. `trigger: 'button'` is the least intrusive — the dialog only
opens when the user clicks the chevron. `trigger: 'focus'` (the default)
opens on focus and closes on blur.

When the popup opens it *reads* the current value of the input and parses it
back into groups, so users can edit what they previously typed. When they
press **Accept**, the notation is written back, `input` and `change` events
are dispatched, and `onAccept` fires.

## Rule reference

Rules are grouped by category in the picker. Every rule produces a notation
fragment that is parsed identically by DICE.js.

### Filter — keep and drop

| Rule | Notation | Notes |
|---|---|---|
| Keep Highest | `kh{n}` | `n` ≤ quantity of the group |
| Keep Lowest | `kl{n}` | |
| Drop Highest | `dh{n}` | `n` ≤ quantity − 1 |
| Drop Lowest | `dl{n}` | |

### Explosions

| Rule | Notation | Notes |
|---|---|---|
| Explode | `!{op}{v}` | Each die that triggers adds another die |
| Explode (Compounding) | `!!{op}{v}` | Exploded values are summed into the original die |
| Penetrating | `p` | World of Darkness style; subsequent dice take −1 |

### Rerolls

| Rule | Notation | Notes |
|---|---|---|
| Reroll | `r{n}{op}{v}` | Rerolls up to `n` times |
| Reroll Once | `ro{op}{v}` | Single reroll |
| Explode & Reroll 1s | `er` | Explodes on max, rerolls 1s |

### Sorting

| Rule | Notation |
|---|---|
| Sort Ascending | `sa` |
| Sort Descending | `sd` |

### Criticals

| Rule | Notation | Notes |
|---|---|---|
| Critical Success | `cs{op}{v}` | Marks dice; does not change the total |
| Critical Failure | `cf{op}{v}` | Marks dice; does not change the total |

### Success counting

| Rule | Notation | Notes |
|---|---|---|
| Target Number | `t{n}` | Counts dice ≥ `n` as successes |
| Failures | `f{n}` | Counts dice < `n` as failures |

### Composing rules

Rules are applied in the order they appear. A group has an ordered list of
`RuleEntry` objects, so `4d6kh3!` (keep the highest 3, then explode those)
and `4d6!kh3` (explode, then keep the top 3 from the result) are both
representable and produce different results.

A group can also carry a flat **bonus** — a signed integer appended to the
notation as `+n` or `-n`.

---

## DieBuilder API reference

### `new DieBuilder(config?)`

Creates a builder. `config` is deep-merged over the internal `DEFAULTS`.
Nothing is rendered until you call `inject()` or `attachTo()`.

```js
const builder = new DieBuilder({
  theme:   { mode: 'dark' },
  labels:  { title: 'Construct your roll' },
  features:{ allowManual: false }
});
```

See the [Configuration reference](#diebuilder-configuration-reference) for
every available key.

---

### `builder.inject(selector) → this`

Renders the standalone panel into a container element or a selector.
Replaces the container's content.

```js
builder.inject('#builder');
builder.inject(document.getElementById('builder'));
```

---

### `builder.attachTo(input, options?) → this`

Attaches the builder to an `<input>` as a popup. `input` may be a selector,
an element, or omitted if `config.popup.targetInput` is set. `options` are
deep-merged over the current config.

```js
builder.attachTo('#notation-input', {
  popup: { trigger: 'button' }
});
```

Wires up: `aria-haspopup="dialog"`, `aria-expanded` toggling, focus / blur
handlers (mode-dependent), Escape-to-close, outside-click-to-close, and
repositioning on scroll and resize.

---

### `builder.init(element, options?) → this`

Convenience wrapper for `inject`, with a config override. Rarely needed.

---

### `builder.setConfig(config) → this`

Deep-merges a partial config into the running instance and re-renders.
Preserves current groups.

```js
builder.setConfig({
  theme: { mode: 'dark' },
  labels: { accept: 'Use this roll' }
});
```

---

### `builder.getNotation() → string`

Returns the current notation string, built from all *valid* groups. Invalid
groups are omitted. Returns `''` if nothing is valid.

```js
// two groups, three rules, plus a bonus
builder.getNotation();  // "4d6dl1+2d20kh1!>15+5"
```

---

### `builder.setNotation(notation) → this`

Replaces the current state by parsing a notation string. Fires `onChange`.

```js
builder.setNotation('4d6dl1 + 2d20kh1 + 5');
```

---

### `builder.getGroups() → Group[]`

Returns a shallow copy of the groups array. Mutating it does **not** affect
the builder — use `addGroup` / `removeGroup` for that.

```js
const groups = builder.getGroups();
// [
//   { id: 'g1', quantity: 4, dieType: 'd6',
//     rules: [{ id: 'dropLowest', ruleModifier: 1, ... }], bonus: 0 },
//   ...
// ]
```

---

### `builder.addGroup(groupData) → this`

Appends a group. Missing fields get defaults (`quantity: 1`, `dieType: 'd6'`,
a single `'none'` rule, `bonus: 0`). Fires `onGroupAdd`.

```js
builder.addGroup({
  quantity: 2,
  dieType: 'd20',
  rules: [
    { id: 'keep',       ruleModifier: 1 },
    { id: 'explode',    limitOperator: '>', limitValue: 15 }
  ]
});
```

---

### `builder.removeGroup(index) → this`

Removes the group at `index`. Fires `onGroupRemove`.

---

### `builder.clear() → this`

Removes every group. Fires `onClear` and `onChange`.

---

### `builder.toggleHelp() → void`

Shows or hides the glossary. In popup mode this flips the card; in standalone
mode it toggles the inline panel.

---

### `builder.validate() → ValidationResult`

Validates the current state. **Never throws** — returns a result object.

```js
const { valid, notation, errors } = builder.validate();

if (!valid) {
  for (const err of errors) {
    console.warn(err.field, err.message);
  }
}
```

`ValidationResult`:

| Property | Type | Notes |
|---|---|---|
| `valid` | `boolean` | |
| `notation` | `string` | The string that was validated |
| `errors` | `ValidationError[]` | Empty when `valid` |

`ValidationError`:

| Property | Type | Notes |
|---|---|---|
| `field` | `string` | `quantity`, `dieType`, `ruleModifier`, `limitValue`, `notation`, or `custom` |
| `message` | `string` | Human-readable |
| `groupId` | `string?` | Present for per-group errors |
| `groupIndex` | `number?` | |
| `ruleIndex` | `number?` | Present for per-rule errors |
| `ruleId` | `string?` | |

---

### `builder.validateNotation(str) → ValidationResult`

Validates an arbitrary notation string **without** touching current state.
Useful for validating user input before committing it.

```js
const check = builder.validateNotation('2d6kh3');
// { valid: false, notation: '2d6kh3',
//   errors: [{ field: 'ruleModifier', message: 'Keep Highest: amount cannot exceed 2', ... }] }
```

---

### `builder.isValid() → boolean`

Boolean shortcut.

---

### `builder.destroy() → this`

Tears down the instance: removes the popup, the trigger button, event
listeners, the focus trap, and the ResizeObserver. After `destroy()` the
instance is unusable — discard the reference.

```js
// Typical SPA cleanup
onUnmount(() => {
  builder.destroy();
  builder = null;
});
```

---

## DieBuilder configuration reference

All keys are optional and deep-merged over the defaults.

### Top-level

| Key | Type | Default | Description |
|---|---|---|---|
| `dieTypes` | `string[]` | `['d4','d6','d8','d10','d12','d20','d100']` | Die types in the picker |
| `validator` | `CustomValidator \| null` | `null` | Extra validation hook |
| `theme` | `Object` | `{ mode: 'light', colors: {} }` | See [Theming](#theming) |
| `labels` | `Object` | see below | UI strings |
| `callbacks` | `Object` | all `null` | See [Callbacks](#callbacks) |
| `features` | `Object` | see below | Feature toggles |
| `popup` | `Object` | see below | Popup-mode config |

### `labels`

Every string in the UI. Override any subset.

| Key | Default |
|---|---|
| `title` | `'Dice Notation Builder'` |
| `addGroup` / `updateGroup` | `'Add Group'` / `'Update'` |
| `clearAll` | `'Clear All'` |
| `copy` / `copied` | `'Copy'` / `'Copied!'` |
| `notation` | `'Notation:'` |
| `noGroups` | `'No groups added yet'` |
| `manualPlaceholder` | `'Or type notation manually...'` |
| `apply` | `'Apply'` |
| `baseDie` / `rule` / `bonus` | `'Base Die'` / `'Rule'` / `'Bonus'` |
| `addRule` / `removeRule` | `'Add Rule'` / `'Remove'` |
| `amount` / `trigger` | `'Amount'` / `'Trigger'` |
| `accept` / `close` | `'Accept'` / `'Close'` |
| `help` / `backToBuilder` | `'Help'` / `'Back to builder'` |
| `openBuilder` | `'Open dice notation builder'` |
| `glossaryTitle` / `glossaryClose` | `'Notation Guide'` / `'Close Glossary'` |

### `callbacks`

| Key | Signature | Fires when |
|---|---|---|
| `onChange` | `(notation, groups) => void` | Any change to groups or notation |
| `onGroupAdd` | `(notation, groups, group) => void` | A group is added or updated |
| `onGroupRemove` | `(notation, groups, group) => void` | A group is removed |
| `onClear` | `(notation, groups) => void` | `clear()` is called |
| `onAccept` | `(notation, groups) => void` | Popup accepted with valid state |
| `onClose` | `() => void` | Popup dismissed without accepting |
| `onError` | `(error) => void` | Unexpected runtime error (bad container, etc.) |
| `onValidate` | `(result) => void` | After every validation pass (debounced 200 ms) |

`onNotationChange` is accepted as an alias for `onChange` for backward
compatibility.

### `features`

| Key | Type | Default | Description |
|---|---|---|---|
| `allowManual` | `boolean` | `true` | Show the manual notation input |
| `showPreview` | `boolean` | `true` | Show the live notation preview |
| `showHelp` | `boolean` | `true` | Show the help button |
| `autoValidate` | `boolean` | `true` | Emit `onValidate` and update the preview as you type |
| `showCategories` | `boolean` | `true` | Group the rule picker into `<optgroup>`s |

### `popup`

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Set automatically by `attachTo` |
| `targetInput` | `string \| HTMLElement \| null` | `null` | Fallback target |
| `trigger` | `'focus' \| 'button' \| 'both'` | `'focus'` | How the popup opens |
| `triggerIcon` | `string` | built-in SVG | Inline SVG for the chevron |
| `width` | `string` | `'80vw'` | Popup width (clamped to `800px`) |
| `maxHeight` | `string` | `'80vh'` | Popup max height (clamped to `600px`) |
| `closeOnOutsideClick` | `boolean` | `true` | |
| `closeOnEscape` | `boolean` | `true` | |

---

## Theming

Two presets ship in the file — `LIGHT_PALETTE` and `DARK_PALETTE`. Switch
between them with `theme.mode`:

```js
new DieBuilder({ theme: { mode: 'dark' } });
```

Override any colour by passing `theme.colors`. Only the keys you provide are
replaced.

```js
new DieBuilder({
  theme: {
    mode: 'light',
    colors: {
      primary:      '#3b82f6',
      primaryHover: '#2563eb',
      primaryRing:  'rgba(59, 130, 246, 0.15)',
      background:   '#ffffff',
      surface:      '#f8fafc',
      text:         '#0f172a',
      border:       '#e2e8f0',
      success:      '#16a34a',
      danger:       '#dc2626',
      warning:      '#d97706'
    }
  }
});
```

Every palette key (all optional):

| Key | Used for |
|---|---|
| `background`, `surface`, `surfaceHover` | Page, cards, hover states |
| `text`, `textMuted`, `textSubtle` | Three-tier text hierarchy |
| `border`, `borderHover`, `borderSubtle` | Three-tier border hierarchy |
| `inputBg`, `shadow` | Form controls, drop shadow |
| `primary`, `primaryHover`, `primaryRing` | Buttons, focus rings, accents |
| `success`, `danger`, `warning` | Semantic states |
| `fontFamily` | Global font stack |

The palette is applied through CSS custom properties
(`--db-primary`, `--db-surface`, …), so any additional selectors you write
can consume them directly:

```css
.db-group-item { border-color: var(--db-primary-ring); }
```

`prefers-reduced-motion` is honoured automatically — animations collapse to
`0.01ms`.

---

## Validation

DieBuilder validates on three levels:

1. **Built-in rule constraints** — quantity ∈ [1, 100], keep/drop counts
   within the group's quantity, trigger values within the die's face range,
   etc.
2. **Custom validator** — a function you supply.
3. **Empty-state checks** — "no groups defined" and "notation is empty".

### Programmatic validation

```js
const { valid, notation, errors } = builder.validate();
```

### Custom validators

Pass `config.validator`. Return `true` or `undefined` for valid, a string
for a custom message, or `false` for a generic "invalid notation" error.

```js
new DieBuilder({
  validator: (notation, groups) => {
    if (groups.length > 4) return 'Maximum of 4 groups per roll';
    if (groups.some(g => g.quantity > 20)) return 'No more than 20 dice per group';
    return true;
  }
});
```

Exceptions thrown inside a validator are caught and reported as a
`{ field: 'custom' }` error — they will never crash the UI.

### Inline errors

When the user clicks **Accept** on an invalid state, the popup stays open
and the offending fields are highlighted. Errors are cleared as soon as the
user edits the relevant input.

---

## DieBuilder examples

### Force advantage-style rolls in a character sheet

```js
const builder = new DieBuilder({
  dieTypes: ['d20'],
  features: { allowManual: false },
  callbacks: {
    onChange: (notation) => {
      document.getElementById('roll-preview').textContent = notation;
    }
  }
});

builder.attachTo('#attack-roll', {
  popup: { trigger: 'button', width: '520px' }
});

// Preset an ability check
builder.setNotation('2d20kh1');
```

### Dark theme, translated strings

```js
new DieBuilder({
  theme: { mode: 'dark' },
  labels: {
    title:        'Würfelnotation',
    addGroup:     'Gruppe hinzufügen',
    accept:       'Übernehmen',
    glossaryTitle:'Notationshandbuch'
  }
}).inject('#builder');
```

### Keeping the popup open until valid

```js
new DieBuilder({
  callbacks: {
    onAccept: (notation) => {
      fetch('/api/roll', {
        method: 'POST',
        body: JSON.stringify({ notation })
      });
    }
  }
}).attachTo('#notation');
```

### Standalone with a preset and a live preview

```js
const builder = new DieBuilder({
  features: { allowManual: true }
}).inject('#builder');

builder.setNotation('4d6dl1 + 2');
```

---

## Accessibility

- Inputs have associated `<label>`s or `aria-label`s.
- The popup is a `role="dialog"` with `aria-modal="true"` and an
  `aria-labelledby` heading.
- Focus is trapped inside the popup while open. Tab and Shift+Tab cycle
  between the target input and the popup's focusables.
- When flipping to the glossary card, the hidden face is marked `inert` and
  `aria-hidden`, so screen readers and tab order skip it.
- The trigger button has an `aria-label` and toggles `aria-expanded` on both
  itself and the target input.
- The notation preview is an `aria-live="polite"` region, so updates are
  announced without interrupting.
- All animations respect `prefers-reduced-motion`.
- All icon-only buttons have visible text alternatives (`aria-label` or
  `title`).

---

## DieBuilder browser support

| Feature | Requirement |
|---|---|
| Core | Any browser with `class` + template literals (ES2015) |
| Focus trap | `inert` — Chrome 102+, Firefox 112+, Safari 15.5+ |
| Auto height sync | `ResizeObserver` — optional; the popup falls back to manual height measurement |
| Clipboard copy | `navigator.clipboard` — falls back to `execCommand('copy')` on older browsers |
| Colour mixing in errors | `color-mix()` — cosmetic only; the banner still shows without it |

No polyfills are bundled.

---
# DICE.js

A dependency-light JavaScript library for rendering and animating polyhedral dice in the browser, with full RPG notation support, physics simulation, and rule evaluation.

Roll `1d20`, `4d6dl1`, `2d6!>4`, `2d20kh1!`, and dozens of other forms. Watch the dice tumble in 3D, land, evaluate the result, and fade away. Everything is configurable at runtime through a single parameter API.
---
## Features

- **Complete dice notation** — keep/drop, explode, compound, penetrate, reroll, sort, crit, target numbers, failures, constants.
- **Recursive rule engine** — explodes and rerolls chain naturally across multiple phases.
- **Real physics** — every die is a Cannon.js rigid body with realistic mass, inertia, friction, and bounciness.
- **Full audit trail** — every rule application is logged in plain English so you can see exactly how a result was reached.
- **Modern API** — Promise-based `roll()`, or classic callbacks if you prefer.
- **Reproducible rolls** — seed the RNG and get byte-identical results, positions, and physics.
- **Forced results** — supply authoritative values and let the dice visually reproduce them.
- **Auto-scaling** — dice shrink smoothly as you roll more of them, so 40d6 still fits in the tray.
- **Responsive** — survives window resizes, orientation changes, and mid-layout container sizing.
- **Configurable fade-out** — dice disappear after a delay you control, or stay forever.
- **Per-rule highlights** — exploding dice glow orange, critical successes green, failures red.
- **Zero required setup** — no build step, no external audio, no tracking.

---

## Dependencies

Load these before `dice.js`:

| Library | Version | Purpose |
|---|---|---|
| [teal.js](https://github.com/TealStar/teal.js) | any | Small DOM utility helpers (`$t`) |
| [three.js](https://threejs.org/) | r7x–r9x | 3D rendering |
| [cannon.js](https://github.com/schteppe/cannon.js) | 0.6.x | Physics simulation |

Newer versions of three.js will not work without code changes. The library uses deprecated APIs like `THREE.Geometry`, `THREE.MeshFaceMaterial`, and `THREE.Face3`, which were removed in r125.

---

## Quick start

```html
<!DOCTYPE html>
<html>
<head>
    <style>
        #dice-tray {
            width: 100%;
            height: 400px;
            position: relative;
        }
    </style>
</head>
<body>
    <div id="dice-tray"></div>

    <script src="teal.js"></script>
    <script src="three.js"></script>
    <script src="cannon.js"></script>
    <script src="dice.js"></script>

    <script>
        var tray = document.getElementById('dice-tray');
        var box = new DICE.dice_box(tray);

        box.setDice('4d6dl1');
        box.roll().then(function(result) {
            console.log('Result:', result.resultString);
            console.log('Total:', result.resultTotal);
        });
    </script>
</body>
</html>
```
That's it. The dice tray renders into #dice-tray, and a click or box.roll() triggers a roll.

## Dice Notation Reference
The parser is deliberately forgiving and accepts whitespace anywhere. Terms are separated by + or - (constants only — negative dice are rejected).

### Basic Dice
| Notation | Meaning |
|---       |---      |
|`d20`|	One twenty-sided die|
|`1d20`|	Same|
|`6d6`|	Six six-sided dice|
|`1d20 + 5`|	One d20, plus a flat +5 to the total|
|`2d6 - 1`|	Two d6, minus 1 from the total|
|`1d8 + 1d6 + 3`|	Mixed pool with a constant|

Supported die types: `d4`, `d6`, `d8`, `d9 (legacy)`, `d10`, `d12`, `d20`, `d100`.

### Keep / Drop Rules
Applied in the order written. Multiple keep/drop rules chain: 6d6kh4dl1 keeps the four highest, then drops the lowest of those four, leaving three.

| Notation | Meaning |
|---       |---      |
|`4d6kh3`|	Roll 4d6, keep the highest 3|
|`4d6kl3`|	Roll 4d6, keep the lowest 3|
|`4d6dh1`|	Roll 4d6, drop the highest 1|
|`4d6dl1`|	Roll 4d6, drop the lowest 1|
|`2d20kh1`|	Advantage — keep the higher of two d20s|
|`2d20kl1`|	Disadvantage — keep the lower of two d20s|

### Exploding Dice
A die that "explodes" is rolled again, and the new result is added to the total. Explosions chain indefinitely until a die fails to trigger.

| Notation | Meaning |
|---       |---      |
|`2d6!`|	Explode on a 6 (max face)|
|`4d6!>4`|	Explode on a value greater than 4|
|`4d6!>=5`|	Same as above, expressed as >=|
|`4d6!5`|	Explode on 5 or higher (shorthand for !>=5)|
|`2d6!!`|	Compounding explosion — the original die's value is retained and the exploded die |is added; the die stays in place and the new value is appended|
|`2d6!!>4`|	Compounding explosion with a threshold|
|`1d10p`|	Penetrating explode (World of Darkness style) — explode on 10, and each subsequent die rolls with a −1 modifier|
|`2d6er`|	Explode on max, and reroll any 1s that appear (see Rerolls)|

### Rerolls
A rerolled die is discarded and physically rerolled. Rerolled dice are greyed out so you can see what was rejected.

| Notation | Meaning |
|---       |---      |
|`1d20r1`|	Reroll 1s until they stop appearing|
|`4d6r1r2`|	Reroll 1s and 2s until neither appears|
|`1d20r>18`|	Reroll anything over 18|
|`1d20ro1`|	Reroll 1s once (if the new value is also a 1, keep it)|
|`1d20ro<5`|	Reroll anything under 5, once|

### Sorting
Sorting affects the final presentation order of kept dice in the result string and result array.

| Notation | Meaning |
|---       |---      |
|`4d6sa`	|Sort the four dice ascending|
|`4d6sd`	|Sort them descending|
|`4d6dl1sa`	|Drop the lowest, then sort remaining ascending|

### Critical Success / Failure
Marks matching dice with a green (success) or red (failure) glow. Does not change the total unless combined with a target-number rule.

| Notation | Meaning |
|---       |---      |
|`1d20cs>15`|	Mark values over 15 as critical successes|
|`1d20cs20`|	Same, shorthand for cs>=20|
|`1d20cf<5`|	Mark values under 5 as critical failures|
|`1d20cf1`|	Same, shorthand for cf<=1|

### Target Numbers and Failures
Change the meaning of the final result from "sum of all kept dice" to "count of dice meeting a condition".

| Notation | Meaning |
|---       |---      |
|`6d10t7`|	Roll 6d10, count how many are 7 or higher|
|`6d10t>6`|	Same|
|`6d10f3`|	Count how many are under 3|
|`6d10f<=2`|	Same|

### Combining rules
Rules chain in written order. This matters — `4d6kh3!` keeps the three highest, then explodes those kept dice. `4d6!kh3` explodes first, then keeps the three highest from the exploded pool.
| Notation | Meaning |
|---       |---      |
|`2d20kh1!>15 ` |  Keep the highest d20, explode it if over 15|
|`4d6dl1!! ` |     Drop the lowest, then compounding-explode the rest|
|`6d6sakh4` |     Sort ascending, then keep the four highest (equivalent to `kh4sa` in effect)|

### Constants
Any bare number is treated as a constant added to (or subtracted from) the final result. Constants cannot be the only term — 5 alone is invalid.

| Notation | Meaning |
|---       |---      |
|`1d20 + 5` |       Valid|
|`1d20 + 5 + 3`|    Valid (equivalent to 1d20 + 8)|
|`-1d20` |          Invalid — dice cannot be negated|
|`5`|             Invalid — no dice in the expression|

## API Reference
### `new DICE.dice_box(container)`
Creates a new dice tray and appends its rendering canvas to container.

#### Parameters

 - container (HTMLElement) — the element to render into. The container must have a non-zero rendered size at the time of the first roll (see Browser support).

#### Returns
 - a dice_box instance.
 ``` js
 var box = new DICE.dice_box(document.getElementById('tray'));
 ```
A `ResizeObserver` is set up automatically so the tray adapts to container size changes. No manual resize handling is required.
___
### `box.setDice(notation)`
Stores the notation string. It is not parsed until a roll begins, so you can safely call this between rolls.
```js
box.setDice('2d20kh1');
box.setDice('4d6dl1 + 5');
box.setDice('6d10t7');
```
___
### `box.roll([options], [before_roll], [after_roll])`
Rolls the dice. Returns a Promise that resolves with the result object, or rejects if the notation is invalid or the tray has no size.

### Parameters
 - `options` (Object, optional)
    - `minBoost` (number, default 2.0) — minimum throw strength multiplier.
    - `maxBoost` (number, default 5.0) — maximum throw strength multiplier.
    - `angle` (number, optional) — throw direction in radians. 0 throws right, Math.PI / 2 throws up. Random if omitted.
 - `before_roll` (Function, optional) called with the parsed notation before physics begins. Return an array of numbers to force specific die results (see Forced results).
 - `after_roll` (Function, optional) — called with the completed result object. The Promise also resolves with the same object, so you can use either style.
 ```js
 // Promise style
const result = await box.roll();
console.log(result.resultTotal);

// Callback style
box.roll(function(result) {
    console.log(result.resultTotal);
});

// Both
box.roll({ angle: 0 }, null, function(result) {
    console.log(result.resultString);
});

// Control throw direction and strength
box.roll({ angle: Math.PI / 4, minBoost: 3, maxBoost: 6 });
 ```

 If a roll is already in progress, the Promise rejects with an error of code `ROLL_IN_PROGRESS`.
___
 ### `box.start_throw([options], [before_roll], [after_roll])`
 Identical to roll() but does not randomise the vector if one isn't provided — it uses whatever the caller supplies, or falls back to a random vector. Mostly useful if you want to supply your own vector and boost rather than having roll() compute them.
 ```js
 box.start_throw({
    vector: { x: 100, y: -50 },
    boost: 800
}, null, function(result) {
    console.log(result.resultTotal);
});
 ```
 ___
### `box.bind_swipe(container, [before_roll], [after_roll])`
Attaches swipe / drag gesture handlers to an element. The direction and speed of the swipe determine the throw. Returns a Promise from each roll if you want to capture results.
```js
box.bind_swipe(document.getElementById('tray'));
```
___
### `box.setOnExplosion(callback)`
Registers a callback fired each time a phase contains exploding dice, before the next phase begins. Useful for triggering sound effects, screen shake, or custom visuals.
```js
box.setOnExplosion(function(info) {
    console.log('Phase', info.phase, 'produced', info.explodedDice.length, 'explosions');
    // info.explodedDice — array of dice that triggered explosions
    // info.phase — recursion depth, 0 for the first phase
    // info.nextNotation — the notation that will be used for the next phase
});
```
____
### `box.setParam(name, value)`
Changes a single configuration parameter at runtime. Throws if the parameter is unknown or the value is out of range.
```js
box.setParam('desk_color', '#1a1a3a');
box.setParam('fade_delay_ms', 5000);
box.setParam('gravity_z', -4000);
box.setParam('rng_seed', 12345);
box.setParam('rng_seed', null);  // revert to Math.random()
```
See [Configuration reference](#configuration-reference) for the full list.
___
### `box.getParam(name)`
Returns the current value of a parameter.
```js
const currentGravity = box.getParam('gravity_z');
```
___
### `box.getParamInfo(name)`
Returns full metadata for a parameter, including its current value.
```js
const info = box.getParamInfo('fade_delay_ms');
// {
//     type: 'integer',
//     min: 0,
//     max: 60000,
//     default: 3000,
//     description: 'Delay before fade begins (ms)',
//     current: 3000
// }
```
___
### `box.setConfig(config)`
Applies a batch of parameter changes in a single call.
```js
box.setConfig({
    desk_color: '#2a2a2a',
    fade_enabled: false,
    size_multiplier: 1.5,
    rng_seed: 42
});
```
___
### `box.getConfig()`
Returns a plain object containing every parameter and its current value.
```js
const fullConfig = box.getConfig();
console.log(fullConfig.desk_color);
```
___
### `box.previewRoll([callback])`
Rolls one of each supported die type, `1d4 + 1d6 + 1d8 + 1d10 + 1d12 + 1d20 + 1d100`; for visual previews and demos. Returns a Promise.
```js
await box.previewRoll();
```
___
### `box.clear()`
Removes all dice from the scene and physics world. Cancels any pending fade. Does not detach the renderer or resize observer.
___
### `box.destroy()`
Full teardown. Removes all dice, disconnects the `ResizeObserver`, disposes of the WebGL renderer, and removes the canvas from the DOM.

After calling `destroy()`, the __instance is unusable__. Discard your reference.
```js
box.destroy();
box = null;
```
___
### `box.reinit(container)`
Rebuilds the camera, lighting, and desk geometry. Called automatically on container resize. You rarely need to call this directly — doing so is safe but only necessary if you've changed the container hierarchy without triggering a resize event.

### Module Level Functions
These are exposed on the `DICE` object and usable without a dice_box instance.

### `DICE.parse_notation(notation)`
Parses a notation string and returns the raw parsed object without rolling anything.
```js
const parsed = DICE.parse_notation('4d6dl1 + 5');
// { groups: [...], set: [...], constant: 5, error: false, ... }
```
___
### `DICE.stringify_notation(parsedNotation)`
Converts a parsed notation back into a string.
```js
const str = DICE.stringify_notation(parsed);
// "4d6dl1 + 5"
```
___
### `DICE.formatAudit(audit)`
Formats an audit array as a newline-separated human-readable string.
```js
const auditText = DICE.formatAudit(result.audit);
console.log(auditText);
```
___

## Configuration Reference
Every parameter below can be read with box.getParam(), written with box.setParam(), or bulk-applied with `box.setConfig()`.

### Physics
|Parameter|Type|Range|Default|Description|
|----|----|----|----|----|
|`gravity_x`|	number|	−10000-10000|	0	|X component of gravity|
|`gravity_y`|	number|	−10000-10000|	0	|Y component of gravity
|`gravity_z`|	number|	−10000-0|7840	|Z component (downward). Lower values pull dice faster
|`solver_iterations`|	integer|	1–100|	16|	Physics solver accuracy|
|`dice_friction`|	number|	0–1	|0.01|	Friction between dice and desk|
|`dice_restitution`|	number|	0–1|	0.5|	Bounciness between dice and desk|
|`dice_dice_friction`|	number|	0–1|	0|	Friction between dice|
|`dice_dice_restitution`|	number|	0–1|	0.5|	Bounciness between dice|
|`linear_damping`|	number|	0–1	|0.1|	How quickly dice slow down|
|`angular_damping`|	number|	0–1	|0.1|	How quickly dice stop spinning|
|`use_adaptive_timestep`|	boolean| -- |true|	Smooth animation via variable timestep|
|`frame_rate`|	number|	0.001–0.1|	1/60|	Fixed timestep in seconds|
### Visuals
|Parameter|Type|Range|Default|Description|
|----|----|----|----|----|
|`camera_distance`|	number|	10–5000|	auto|	Camera Z distance. null computes it|
|`camera_fov`|	number|	5–90|	20|	Camera field of view (degrees)|
|`ambient_light_color`|	color|	—|	#f0f0f0|	Ambient light colour|
|`spot_light_color`|	color|	—|	#efefef|	Spot light colour|
|`spot_light_intensity`|	number|	0–10|	2.0|	Spot light brightness|
|`desk_color`|	color|	—|	#101010|	Desk surface colour|
|`desk_opacity`|	number|	0–1|0.5|	Desk opacity (0 = invisible)|
|`use_shadows`|	boolean|	—|	true|	Enable shadow rendering|
|`dice_color`|	color|	—|	#202020|	Default die body colour|
|`label_color`|	color|	—|	#aaaaaa|	Default face label colour|
|`dropped_dice_color`|	color|—|	#4d4d4d|	Body colour for dropped dice|
|`dropped_dice_label_color`|	color|	—|	#1a1a1a|	Label colour for dropped dice|
### Behaviour
|Parameter|Type|Range|Default|Description|
|----|----|----|----|----|
|`d100_compound`|	boolean|	—|	true|	Roll d100 as a tens die + a units die|
|`max_recursion_depth`|	integer| 1–50|	10	|Maximum explosion/reroll phases|
|`max_dice_per_roll`|	integer|	1–500|	100	|Total dice cap across all phases|
|`explosion_delay_ms`|	integer|	0–1500	|300	|Delay between explosion phases|
### Size Control
|Parameter|Type|Range|Default|Description|
|----|----|----|----|----|
|`size_multiplier`|	number|	0.1–3.0|	1.0|	Global size multiplier for dice|
|`auto_scale_enabled`|	boolean|	--	|true	|Shrink dice automatically for large pools|
|`auto_scale_baseline_dice`|	integer|	1–50|	6	|Dice count at which full base size applies|
|`auto_scale_exponent`|	number|	0–1.5|	0.5|	Auto-shrink curve steepness|
|`auto_scale_min_factor`|	number|	0.05–1.0|	0.35|	Minimum size as a fraction of base|
#### Auto-scaling Formula
```
factor = clamp((baseline / count) ^ exponent, minFactor, 1)
scale  = baseScale * sizeMultiplier * factor
```
#### Auto Scaling Defaults
|Dice count|	Relative size|
|---|---|
|1–6|	100%|
|12	|~71%|
|24|	~50%|
|50+|	35% (floor)|

### Fade-Out
|Parameter|Type|Range|Default|Description|
|----|----|----|----|----|
|`fade_enabled`|	boolean|	—|	true|	Fade dice out after a roll|
|`fade_delay_ms`|	integer|	0–60000|	3000|	Delay before the fade begins|
|`fade_duration_ms`|	integer|	0–10000|	800|	Duration of the fade|
### Timeouts and Reproducibility
|Parameter|Type|Range|Default|Description|
|----|----|----|----|----|
|`roll_timeout_ms`|	integer|	0–120000|	20000|	Force-reset rolling if exceeded. 0 |disables
|`rng_seed`|	integer | null|	0 to 2³¹−1|	null|	Seed for reproducible rolls. null = random|
___
## Result Object Reference
The Promise from `roll()` resolves with an object containing everything about the roll. This is also the argument passed to `after_roll`.
|Property|Type|Description|
|---|----|----|
|`groups`|	array|	The parsed notation groups this roll was based on|
|`set`|	array|	Flattened list of physical dice types (backward-compatibility)|
|`constant`|	number|	The flat modifier from the notation, if any|
|`result`|	number[]|	Final kept die values, in presentation order|
|`diceResults`|	object[]|	Full per-logical-die objects (including dropped dice)|
|`resultTotal`|	number|	Final numeric result|
|`resultString`|	string|	Human-readable summary, e.g. "4 3 5 6 = 18"|
|`audit`|	object[]|	Structured audit trail of every rule application|
|`auditString`|	string	|The audit trail formatted as plain English|
|`error`|	boolean|	True if the roll failed|
|`errorCode`|	string|null|	One of the codes from DICE_ERRORS if failed|
|`errorMessage`|	string|null|	Human-readable error message|

### Audit Trail Format
Each audit entry has this shape:
```json
{
    step: 0,                    // Sequential step number
    phase: 0,                   // Recursion depth
    type: 'roll',               // Event type
    description: 'Rolled 4 dice: 3, 5, 2, 6.',
    details: { ... }            // Structured data for that event
}
````
Event types include `roll`, `keep-highest`, `keep-lowest`, `drop-highest`, `drop-lowest`, `explode`, `reroll`, `sort`, `critical`, `target`, `failures`.
___
## Examples

### Basic Attack Roll With _advantage_ and _critical hit_
```js
box.setDice('2d20kh1cs>19 + 5');

const result = await box.roll();
console.log(`Attack: ${result.resultTotal}`);

if (result.diceResults.some(d => d.critical)) {
    console.log('Critical hit!');
}
```
___
### Multi-die Damage Roll
```js
box.setDice('8d6');
box.setDice('8d6sa');  // Sorted, easier to read
const result = await box.roll();
console.log(`Fireball: ${result.resultString}`);
```
___
### Roll with Hidden Dice (dark theme)
```js
box.setConfig({
    desk_color: '#0a0a0a',
    dice_color: '#1a1a1a',
    label_color: '#dddddd',
    ambient_light_color: '#333333',
    spot_light_color: '#ffffff',
    spot_light_intensity: 3.0
});

box.setDice('1d20');
await box.roll();
```
___
### Reproducible Rolls For Testing
```js
box.setParam('rng_seed', 12345);
box.setDice('20d6');
const a = await box.roll();

box.setParam('rng_seed', 12345);
box.setDice('20d6');
const b = await box.roll();

console.log(a.resultTotal === b.resultTotal);  // true
```
___
### Forced Results / Fudging the Roll
A _controversial_ one. Use before_roll to force the outcome so the physics animation reproduces it.
```js
box.setDice('4d6dl1');

const result = await box.roll(function(notation) {
    // Return one value per physical die
    return [4, 2, 6, 5];
});

console.log(result.resultTotal);  // 4 + 6 + 5 = 15 (2 was dropped)
```
For recursive rolls (explosions), __forced results apply only to the first phase__. Subsequent phases (explosions, rerolls) roll normally.
___
### Persistant Dice Tray
```js
box.setParam('fade_enabled', false);
```
Or use a long delay:
```js
box.setParam('fade_delay_ms', 30000);
```
___
### Touch-Friendly Swipe Roll
#### HTML
```html
<div id="tray" style="touch-action: none; height: 400px;"></div>
```
#### JavaScript
```js
const tray = document.getElementById('tray');
const box = new DICE.dice_box(tray);
box.setDice('1d20');
box.bind_swipe(tray);
```
___
### Custom Explosion Effect
```js
box.setOnExplosion(function(info) {
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 200);
});
box.setDice('6d6!');
box.roll();
```
___
### Cleanup (in a Single Page App)
```js
function onUnmount() {
    if (box) {
        box.destroy();
        box = null;
    }
}
```
___
## Advanced Topics
### Forced results
`before_roll` receives the parsed notation and can return an array of die values. The array must have one entry per logical die (a d100 in compound mode counts as one entry, and is split into tens and units automatically).

The values are applied to the physical dice after the simulation settles, using a face-label shift. The dice still animate and tumble realistically, they just land on the requested values.

If you force a value outside a die's valid range (e.g. a 7 on a d6), that die's shift is silently skipped and it keeps whatever value the physics produced.

### Seeded RNG
Setting rng_seed to an integer replaces the internal `Math.random()` call with a `Mulberry32 PRNG`. Every call to the random source; initial position, velocity, spin, orientation, and also throw direction, is drawn from the seeded stream.

Two rolls with the same seed produce identical results, including the exact physics simulation. This makes the library suitable for tests, replays, and fairness verification.

The seed is module-global, not per-instance. If you use multiple dice boxes on the same page, they share the seed. Setting rng_seed to null reverts to true randomness.

### The Audit Trail
Every roll produces a full audit trail. Useful for debugging, for showing _"why"_ a result came out the way it did, and for logging on servers.
```js
const result = await box.roll();
console.log(result.auditString);
// Step 0: Rolled 4 dice: 3, 5, 2, 6.
// Step 1: Dropped 1 die (IDs: 2) with rule "drop-lowest".
// Step 2: Sorted dice ascending.
```
### Resize behaviour
The tray resizes automatically via `ResizeObserver` (with a window resize fallback for older browsers). The camera, lighting, desk, and physics barriers all follow.

Dice already on screen are not resized, they retain the size they had when rolled.

The next roll uses the new size, adjusted by the auto-scaling factor.

A resize while the container is hidden is ignored so a stale size never wipes a working scale.

### Multi-instance caveats
The library was designed for one tray per page. If you create multiple `dice_box` instances, be aware that:

`vars` and the `RNG` seed are module-global — a `setParam` on one box affects all of them.

The geometry cache is shared; the first box to build a d20 geometry at a given scale fixes it for all boxes until the scale changes.

Single-tray applications are unaffected.

## Browser Support and Mobile Notes
WebGL is required. The library falls back to THREE.CanvasRenderer if WebGL isn't available, but visual quality is dramatically reduced.

The container must have a non-zero rendered size when the first roll is attempted. If you construct the dice_box before the container has laid out (common with flex/grid layouts, or if the element is added to the DOM in the same tick), rolls will fail with a RENDER_FAILED error.

Two safe patterns:
```js
// Wait for the next frame after adding to the DOM
requestAnimationFrame(function() {
    var box = new DICE.dice_box(container);
    box.setDice('1d20');
    box.roll();
});
```

```js
// Or use an explicit height in CSS
// #tray { height: 400px; }
```

### Touch Events on Mobile
For `bind_swipe` to reliably capture gestures, add `touch-action: none;` to the container's CSS. Without it, the browser may claim the touch for scrolling before the handler fires.

### Error Codes
Rolls reject with an error object carrying a `code` and a `userMessage`. Codes include:
|Code|	Meaning|
|----|----|
|`EMPTY_NOTATION`|	No notation supplied|
|`NO_DICE`|	Notation contained constants but no dice|
|`INVALID_NOTATION`|	Unrecognised term|
|`INVALID_RULE`|	Unrecognised rule suffix|
|`UNSUPPORTED_DIE`|	Die type not in d4, d6, d8, d9, d10, d12, d20, d100|
|`ZERO_DICE`|	0d6 and similar|
|`NEGATIVE_DICE_TERM`|	-1d20|
|`RULE_COUNT_EXCEEDS_DICE`|	2d6kh3|
|`RECURSION_DEPTH_EXCEEDED`|	Too many explosion phases|
|`TOO_MANY_DICE`|	Exceeded max_dice_per_roll|
|`RENDER_FAILED`|	Container has no size, or physics failed to initialise|
|`CALLBACK_ERROR`|	Error inside before_roll or after_roll|
|`ROLL_IN_PROGRESS`|	A roll is already running|
|`UNKNOWN_ERROR`|Catch-all|

Invalid notations never throw — they reject the Promise (or pass an error-shaped object to `after_roll`).
___
# Shared notation reference

Both libraries operate on the same grammar. A term is one of:

```
<quantity>d<sides>          // e.g. 4d6, 1d20
<term>kh<n>                 // keep highest n
<term>kl<n>                 // keep lowest n
<term>dh<n>                 // drop highest n
<term>dl<n>                 // drop lowest n
<term>!{op}{v}              // explode on {op} v   (op defaults to '=')
<term>!!{op}{v}             // compounding explosion
<term>p                    // penetrating explosion
<term>r{n}{op}{v}           // reroll up to n times
<term>ro{op}{v}             // reroll once
<term>er                   // explode on max, reroll 1s
<term>sa | sd              // sort ascending / descending
<term>cs{op}{v}             // critical success
<term>cf{op}{v}             // critical failure
<term>t{n}                  // target number
<term>f{n}                  // failures
```

Terms are joined with `+`. Constants (`+5`, `-2`) are added to the total.
Leading `-` on a dice term is invalid.

```text
1d20                        // one d20
4d6dl1                      // roll 4d6, drop the lowest
2d20kh1!>15                 // advantage, explode on >15
6d6!!>4                     // 6d6 compounding-explode on >4
8d6sa + 3                   // 8d6 sorted ascending, plus 3
6d10t7                      // count dice showing 7 or higher
```

`DieBuilder`'s rule picker exposes every one of these. The
[Rule reference](#rule-reference) above lists them by category;
`DICE.js`'s readme lists them by notation.

---

# Using them together

The whole point of the split: `DieBuilder` is a **notation editor**; `DICE.js` is
a **notation executor**. You wire the first into the second with a single
callback.

```html
<div id="builder"></div>
<div id="tray" style="height: 400px; position: relative;"></div>

<script src="teal.js"></script>
<script src="three.js"></script>
<script src="cannon.js"></script>
<script src="dice.js"></script>
<script src="die-builder.js"></script>
<script>
  const box = new DICE.dice_box(document.getElementById('tray'));

  const builder = new DieBuilder({
    callbacks: {
      onAccept: async (notation) => {
        box.setDice(notation);
        const result = await box.roll();
        console.log(result.resultString, '=', result.resultTotal);
      }
    }
  });

  builder.inject('#builder');
</script>
```

Attached to an input instead of an inline panel:

```js
builder.attachTo('#notation', {
  popup: { trigger: 'button' }
});
```

And that's it. The same notation grammar guarantees that whatever the user builds, DICE.js can roll.

A few integration notes worth internalising:

- **Validate before rolling.** `onAccept` only fires with a valid state, but
  if you're also letting users type raw notation into the input, run
  `builder.validateNotation(str)` before handing it to `box.setDice(str)`.
- **Presets are one line.** `builder.setNotation('2d20kh1')` at load time
  repopulates the editor and syncs the preview.
- **Audit trails work either way.** DICE.js's `result.auditString` is a
  plain-English explanation of how the roll was resolved — a natural thing
  to show next to the DieBuilder panel.
- **Seed for tests.** `box.setParam('rng_seed', 42)` + a preset notation from
  DieBuilder gives you a fully deterministic, reproducible pipeline.

---

# License

See `LICENSE` in the repository.

- **DICE.js** — original library by `Anton Natarov (Teal)`; subsequently forked from a
  repository authored by `Sarah Rosanna Busch`; this version is a comprehensive
  refactor with advanced rules, audit, and a modernised API.
- **DieBuilder** — see `LICENSE`.