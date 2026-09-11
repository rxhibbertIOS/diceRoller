"use strict";

/**
 * @brief Generates polyhedral dice with 3D roll animation, physics and
 *        notation/result handling.
 *
 * This library is deliberately split into a few conceptual layers:
 *
 *   notation
 *       ↓
 *   roll groups / rules
 *       ↓
 *   physical dice
 *       ↓
 *   physics
 *       ↓
 *   raw physical results
 *       ↓
 *   result evaluation
 *       ↓
 *   final numeric result
 *
 * The physics layer knows nothing about keep/drop rules. It only knows
 * which physical dice exist and how they move.
 *
 * The result layer knows about dice groups and evaluates rules such as:
 *
 *   2d20kh1
 *   2d20kl1
 *   4d6dl1
 *   4d6dh1
 *   2d6!          (explode on max)
 *   4d6!>4        (explode on value > 4)
 *   1d20r1        (reroll 1s until success)
 *   1d20ro1       (reroll 1s once)
 *   2d6!!         (compounding explosion)
 *   1d10p         (penetrating, WoD)
 *   4d6dl1!       (drop lowest, then explode kept)
 *   2d20kh1!>15   (keep highest, then explode if >15)
 *
 * @author Anton Natarov aka Teal (original author)
 * @author Sarah Rosanna Busch (refactor, see changelog)
 * @author Rory Hibbert (refactor, see changelog)
 * @date 10 Aug 2023
 * @version 2.0 (with advanced rules and audit)
 * @dependencies teal.js, cannon.js, three.js
 */

/**
 * CHANGELOG - v2.0
 * - Added advanced notation parsing for explosions, rerolls, sorting, crits, target numbers.
 * - Implemented recursive roll engine for dynamic dice (explosions/rerolls).
 * - Added full audit trail with natural language output.
 * - Group rules now stored as an array `rules` instead of a single `rule`.
 * - Removed hard limit of 10 dice per group (now configurable via `max_dice_per_group`).
 * - Added safety guards against infinite recursion.
 * - Explosion dice now inherit group colour.
 * - Simple rolls now also produce a full audit trail.
 * - Fixed colour inheritance for deeper recursion levels.
 */

var DICE = (function() {

    var that = {};

    /**
     * Error codes and their user‑friendly messages.
     * @enum {string}
     */
    var DICE_ERRORS = {
        INVALID_NOTATION: 'Invalid dice notation – please check the syntax.',
        EMPTY_NOTATION: 'No dice notation provided.',
        NO_DICE: 'No dice were specified in the notation.',
        UNSUPPORTED_DIE: 'Unsupported die type. Use d4, d6, d8, d10, d12, d20, or d100.',
        ZERO_DICE: 'Number of dice must be at least 1.',
        TOO_MANY_DICE_PER_GROUP: 'Maximum 10 dice per group allowed.',
        TOO_MANY_GROUPS: 'Maximum 10 groups allowed per roll.',
        INVALID_RULE: 'The keep/drop rule is malformed or uses an unsupported type.',
        RULE_COUNT_EXCEEDS_DICE: 'The rule count cannot exceed the number of dice in the group.',
        NEGATIVE_DICE_TERM: 'Dice terms cannot be negative.',
        VECTOR_GENERATION_FAILED: 'Failed to generate the physical dice vectors.',
        RENDER_FAILED: 'An error occurred during rendering or physics.',
        CALLBACK_ERROR: 'An error occurred in a user callback (before_roll or after_roll).',
        RECURSION_DEPTH_EXCEEDED: 'Maximum recursion depth reached (infinite explosion/reroll loop).',
        TOO_MANY_DICE: 'Too many dice generated (exceeded safety limit).',
        UNKNOWN_ERROR: 'An unexpected error occurred during the dice roll.',
    };

    function _clearRollWatchdog(box) {
        if (box._rollWatchdog) {
            clearTimeout(box._rollWatchdog);
            box._rollWatchdog = null;
        }
    }

    function _setRollWatchdog(box, notation) {
        _clearRollWatchdog(box);
        var timeoutMs = vars.roll_timeout_ms;
        if (!timeoutMs || timeoutMs <= 0) return;

        box._rollWatchdog = setTimeout(function() {
            box._rollWatchdog = null;
            if (!box.rolling) return;
            console.warn('Dice Roll: roll exceeded timeout of', timeoutMs, 'ms — resetting rolling flag');
            box.rolling = false;
            // Deliberately do NOT clear dice here — the pipeline may still be
            // mid-flight and would recreate them anyway on the next phase.
        }, timeoutMs);
    }

    /**
     * Creates a structured error object for the dice engine.
     *
     * @param {string} code - One of the keys in DICE_ERRORS.
     * @param {string} [customMessage] - Optional override for the user message.
     * @param {Error} [originalError] - The original caught error (to preserve stack).
     * @returns {Error} A new Error object with additional properties.
     */
    function createDiceError(code, customMessage, originalError) {
        var userMsg = DICE_ERRORS[code] || 'An unknown error occurred.';
        if (customMessage) {
            userMsg = customMessage;
        }
        var err = new Error(userMsg);
        err.code = code;
        err.userMessage = userMsg;
        if (originalError) {
            err.stack = originalError.stack;
            err.originalError = originalError;
        }
        console.error('Dice Roll: [' + code + '] ' + userMsg, err);
        return err;
    }

    /**
     * Central error handler – clears dice, builds error notation, and calls after_roll.
     *
     * @param {Object} box - The dice_box instance.
     * @param {Error} error - The caught error object.
     * @param {Function} afterRollCb - The user-provided after_roll callback (may be null).
     * @param {Object} [originalNotation] - The parsed notation (if available) to preserve groups.
     */
    function _handleDiceError(box, error, afterRollCb, originalNotation) {
        // Clear any dice left in the scene
        try { box.clear(); } catch (e) { /* ignore */ }
        box.rolling = false;
        _clearRollWatchdog(box);
        // Build an error notation
        var err = createDiceError(
            error.code || 'UNKNOWN_ERROR',
            error.userMessage || error.message,
            error
        );
        var notation = {
            error: true,
            errorCode: err.code,
            errorMessage: err.userMessage,
            errorStack: err.stack,
            groups: originalNotation ? originalNotation.groups : [],
            set: originalNotation ? originalNotation.set : [],
            constant: originalNotation ? originalNotation.constant : 0,
            result: [],
            diceResults: [],
            resultTotal: 0,
            resultString: 'Error: ' + err.userMessage,
            audit: [],
            auditString: ''
        };
        if (afterRollCb) {
            afterRollCb(notation);
        } else {
            console.error('Dice Roll: Unhandled error – no after_roll callback.', err);
        }
    }

    /**
     * Converts an operator string (>, >=, <, <=, =) to a condition name.
     */
    function operatorToCondition(op) {
        switch (op) {
            case '>=': return 'greater-equal';
            case '<=': return 'less-equal';
            case '>':  return 'greater-than';
            case '<':  return 'less-than';
            case '=':  return 'equal';
            default:   return null;
        }
    }

    /**
     * Compares a value against a threshold using the given condition name.
     */
    function compareValues(value, condition, threshold) {
        switch (condition) {
            case 'greater-than':  return value > threshold;
            case 'greater-equal': return value >= threshold;
            case 'less-than':     return value < threshold;
            case 'less-equal':    return value <= threshold;
            case 'equal':         return value === threshold;
            default:              return false;
        }
    }

    /**
     * Renders a condition + threshold back to a short string (e.g. ">19", "=6").
     */
    function conditionToString(condition, threshold) {
        switch (condition) {
            case 'greater-than':  return '>' + threshold;
            case 'greater-equal': return '>=' + threshold;
            case 'less-than':     return '<' + threshold;
            case 'less-equal':    return '<=' + threshold;
            case 'equal':         return '=' + threshold;
            default:              return '>' + threshold;
        }
    }

    var rngSeed = null;
    var _rng = null;

    function mulberry32(a) {
        return function() {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function setRngSeed(seed) {
        if (seed === null || seed === undefined) {
            rngSeed = null;
            _rng = null;
            return;
        }
        rngSeed = seed;
        _rng = mulberry32(seed);
    }

    /**
     * Internal rendering and physics configuration.
     *
     * These values currently remain internal to the library. The longer-term
     * plan is to expose presentation and simulation settings separately so
     * callers can customise the appearance and throwing behaviour without
     * coupling themselves to Three.js or Cannon.js internals.
     */
    var vars = {
        frame_rate: 1 / 60,
        scale: 100,

        material_options: {
            specular: 0x172022,
            color: 0xf0f0f0,
            shininess: 40,
            shading: THREE.FlatShading,
        },

        label_color: '#aaaaaa',
        dice_color: '#202020',
        dropped_dice_color: '#4d4d4d',
        dropped_dice_label_color: '#1a1a1a',

        ambient_light_color: 0xf0f0f0,
        spot_light_color: 0xefefef,

        desk_color: '#101010',
        desk_opacity: 0.5,

        use_shadows: true,

        /*
         * If true, d100 rolls are compound: a tens die and a units die.
         * Keep/drop rules apply to the combined 1-100 value.
         * If false, d100 rolls only a single tens die (0,10,...90).
         */
        d100_compound: true,

        /*
         * Adaptive timestep produces more natural-looking animation.
         *
         * Setting this to false improves performance but changes the visual
         * character of the roll.
         */
        use_adaptive_timestep: true,

        /*
         * Preset colours for dice groups (up to 10 groups).
         * These are applied automatically when no custom colour is provided
         * via the group's visual.color property.
         */
        preset_colours: [
            0x943126, // red
            0x22628c, // blue
            0x18683a, // green
            0x7b6508, // yellow
            0x633975, // purple
            0x935116, // orange
            0x0e6050, // teal
            0x952B5e, // pink
            0x00765e, // mint
            0x453b94  // indigo
        ],

        linear_damping: 0.1,
        angular_damping: 0.1,
        spot_light_intensity: 2.0,

        // settings for advanced rules
        max_recursion_depth: 50,        // prevent infinite loops
        max_dice_per_roll: 100,         // safety cap for total dice
        explosion_delay_ms: 300,        // delay before exploding dice are rolled

        // Size control
        size_multiplier: 1.0,              // user-facing "make dice bigger/smaller" (0.5–2.0 sensible range)
        auto_scale_enabled: true,          // shrink automatically based on dice count?
        auto_scale_baseline_dice: 6,       // count at which the base size is used unchanged
        auto_scale_exponent: 0.5,          // 0.5 => area-preserving; raise for more aggressive shrink
        auto_scale_min_factor: 0.35,       // never shrink below this fraction of base size

        // Fade-out control
        fade_enabled: true,          // false disables fade entirely
        fade_delay_ms: 3000,         // how long after the roll settles before fading begins
        fade_duration_ms: 800,       // how long the fade takes

        roll_timeout_ms: 20000,   // force-reset box.rolling if a roll exceeds this
        rng_seed: null,           // null = Math.random()
    };

    /**
     * Constants used by the dice engine.
     */
    const CONSTS = {

        /*
         * Dice types that the geometry/renderer knows how to create.
         *
         * d9 is retained for compatibility with the original library,
         * although the public notation parser intentionally only accepts
         * standard RPG dice at present.
         */
        known_types: [
            'd4',
            'd6',
            'd8',
            'd9',
            'd10',
            'd12',
            'd20',
            'd100'
        ],

        /*
         * Internal face-number ranges.
         *
         * d10 uses 0 internally and converts 0 to 10 when exposed.
         * d100 uses the d10 geometry and exposes 0, 10, 20 ... 90.
         * Physical d100 values are 0-9 (tens digit).
         */
        dice_face_range: {
            'd4': [1, 4],
            'd6': [1, 6],
            'd8': [1, 8],
            'd9': [0, 9],
            'd10': [0, 9],
            'd12': [1, 12],
            'd20': [1, 20],
            'd100': [0, 9]   // physical tens digit
        },

        dice_mass: {
            'd4': 300,
            'd6': 300,
            'd8': 340,
            'd9': 350,
            'd10': 350,
            'd12': 350,
            'd20': 400,
            'd100': 350
        },

        dice_inertia: {
            'd4': 5,
            'd6': 13,
            'd8': 10,
            'd9': 9,
            'd10': 9,
            'd12': 8,
            'd20': 6,
            'd100': 9
        },

        /*
         * Standard labels used by most polyhedral dice.
         *
         * Index zero is the blank/non-numbered material.
         */
        standart_d20_dice_face_labels: [
            ' ',
            '0',
            '1',
            '2',
            '3',
            '4',
            '5',
            '6',
            '7',
            '8',
            '9',
            '10',
            '11',
            '12',
            '13',
            '14',
            '15',
            '16',
            '17',
            '18',
            '19',
            '20'
        ],

        standart_d100_dice_face_labels: [
            ' ',
            '00',
            '10',
            '20',
            '30',
            '40',
            '50',
            '60',
            '70',
            '80',
            '90'
        ],

        d4_labels: [
            [
                [],
                [0, 0, 0],
                [2, 4, 3],
                [1, 3, 4],
                [2, 1, 4],
                [1, 2, 3]
            ],
            [
                [],
                [0, 0, 0],
                [2, 3, 4],
                [3, 1, 4],
                [2, 4, 1],
                [3, 2, 1]
            ],
            [
                [],
                [0, 0, 0],
                [4, 3, 2],
                [3, 4, 1],
                [4, 2, 1],
                [3, 1, 2]
            ],
            [
                [],
                [0, 0, 0],
                [4, 2, 3],
                [1, 4, 3],
                [4, 1, 2],
                [1, 3, 2]
            ]
        ]
    };

    /**
     * Configuration parameter definitions.
     * Each entry: { type, min, max, default, description }
     */
    const CONFIG_DEFS = {
    // Physics
    gravity_x: { type: 'number', min: -10000, max: 10000, default: 0, description: 'X component of gravity' },
    gravity_y: { type: 'number', min: -10000, max: 10000, default: 0, description: 'Y component of gravity' },
    gravity_z: { type: 'number', min: -10000, max: 0, default: -9.8 * 800, description: 'Z component of gravity (downward)' },
    solver_iterations: { type: 'integer', min: 1, max: 100, default: 16, description: 'Physics solver accuracy' },
    dice_friction: { type: 'number', min: 0, max: 1, default: 0.01, description: 'Friction between dice and desk' },
    dice_restitution: { type: 'number', min: 0, max: 1, default: 0.5, description: 'Bounciness between dice and desk' },
    dice_dice_friction: { type: 'number', min: 0, max: 1, default: 0, description: 'Friction between dice' },
    dice_dice_restitution: { type: 'number', min: 0, max: 1, default: 0.5, description: 'Bounciness between dice' },
    linear_damping: { type: 'number', min: 0, max: 1, default: 0.1, description: 'Linear damping of dice' },
    angular_damping: { type: 'number', min: 0, max: 1, default: 0.1, description: 'Angular damping of dice' },
    use_adaptive_timestep: { type: 'boolean', default: true, description: 'Use adaptive timestep' },
    frame_rate: { type: 'number', min: 0.001, max: 0.1, default: 1 / 60, description: 'Fixed timestep (seconds)' },

    // Visuals
    camera_distance: { type: 'number', min: 10, max: 5000, default: null, description: 'Camera Z distance (computed if null)' },
    camera_fov: { type: 'number', min: 5, max: 90, default: 20, description: 'Camera field of view (degrees)' },
    ambient_light_color: { type: 'color', default: '#f0f0f0', description: 'Ambient light colour' },
    spot_light_color: { type: 'color', default: '#efefef', description: 'Spot light colour' },
    spot_light_intensity: { type: 'number', min: 0, max: 10, default: 2.0, description: 'Spot light brightness' },
    desk_color: { type: 'color', default: '#101010', description: 'Desk surface colour' },
    desk_opacity: { type: 'number', min: 0, max: 1, default: 0.5, description: 'Desk opacity' },
    use_shadows: { type: 'boolean', default: true, description: 'Enable shadows' },
    dice_color: { type: 'color', default: '#202020', description: 'Default die body colour' },
    label_color: { type: 'color', default: '#aaaaaa', description: 'Default label colour' },
    dropped_dice_color: { type: 'color', default: '#4d4d4d', description: 'Dropped die colour' },
    dropped_dice_label_color: { type: 'color', default: '#1a1a1a', description: 'Dropped die label colour' },

    // Behaviour
    d100_compound: { type: 'boolean', default: true, description: 'Roll d100 as tens + units' },
    max_recursion_depth: { type: 'integer', min: 1, max: 50, default: 10, description: 'Maximum explosion/reroll recursions' },
    max_dice_per_roll: { type: 'integer', min: 1, max: 500, default: 100, description: 'Safety cap on total dice generated' },
    explosion_delay_ms: { type: 'integer', min: 0, max: 1500, default: 300, description: 'Delay before exploding dice are rolled (ms)' },
    
    // Size control
    size_multiplier:          { type: 'number',  min: 0.1,  max: 3.0,  default: 1.0,  description: 'Global size multiplier for dice' },
    auto_scale_enabled:       { type: 'boolean', default: true,         description: 'Shrink dice automatically when many are rolled' },
    auto_scale_baseline_dice: { type: 'integer', min: 1,    max: 50,   default: 6,    description: 'Dice count at which base size is used' },
    auto_scale_exponent:      { type: 'number',  min: 0,    max: 1.5,  default: 0.5,  description: 'Auto-shrink curve exponent' },
    auto_scale_min_factor:    { type: 'number',  min: 0.05, max: 1.0,  default: 0.35, description: 'Minimum auto-shrink factor' },

    // Fade-out control
    fade_enabled:     { type: 'boolean', default: true, description: 'Fade dice out after a roll' },
    fade_delay_ms:    { type: 'integer', min: 0, max: 60000, default: 3000, description: 'Delay before fade begins (ms)' },
    fade_duration_ms: { type: 'integer', min: 0, max: 10000, default: 800, description: 'Fade duration (ms)' },

    roll_timeout_ms: { type: 'integer', min: 0, max: 120000, default: 20000, description: 'Max time (ms) before a roll is force-reset (0 = disabled)' },
    rng_seed:        { type: 'integer', min: 0, max: 0x7FFFFFFF, default: null, nullable: true, description: 'Seed for deterministic rolls (null = random)' },
    };

    // Helper to get current values from vars or instance
    function getConfigValue(name, instance) {
        // Map config names to actual storage locations
        const map = {
            gravity_x: () => instance.world.gravity.x,
            gravity_y: () => instance.world.gravity.y,
            gravity_z: () => instance.world.gravity.z,
            solver_iterations: () => instance.world.solver.iterations,
            dice_friction: () => instance._deskDiceContact?.friction || 0.01,
            dice_restitution: () => instance._deskDiceContact?.restitution || 0.5,
            dice_dice_friction: () => instance._diceDiceContact?.friction || 0,
            dice_dice_restitution: () => instance._diceDiceContact?.restitution || 0.5,
            linear_damping: () => vars.linear_damping || 0.1,
            angular_damping: () => vars.angular_damping || 0.1,
            use_adaptive_timestep: () => vars.use_adaptive_timestep,
            frame_rate: () => vars.frame_rate,
            camera_distance: () => instance.camera?.position.z || instance.wh,
            camera_fov: () => instance.camera?.fov || 20,
            ambient_light_color: () => `#${vars.ambient_light_color.toString(16).padStart(6, '0')}`,
            spot_light_color: () => `#${vars.spot_light_color.toString(16).padStart(6, '0')}`,
            spot_light_intensity: () => vars.spot_light_intensity || 2.0,
            desk_color: () => vars.desk_color,
            desk_opacity: () => vars.desk_opacity,
            use_shadows: () => vars.use_shadows,
            dice_color: () => `#${vars.dice_color.toString(16).padStart(6, '0')}`,
            label_color: () => vars.label_color,
            dropped_dice_color: () => vars.dropped_dice_color,
            dropped_dice_label_color: () => vars.dropped_dice_label_color,
            d100_compound: () => vars.d100_compound,
            max_recursion_depth: () => vars.max_recursion_depth,
            max_dice_per_roll: () => vars.max_dice_per_roll,
            explosion_delay_ms: () => vars.explosion_delay_ms,
            size_multiplier:          () => vars.size_multiplier,
            auto_scale_enabled:       () => vars.auto_scale_enabled, 
            auto_scale_baseline_dice: () => vars.auto_scale_baseline_dice,
            auto_scale_exponent:      () => vars.auto_scale_exponent,
            auto_scale_min_factor:    () => vars.auto_scale_min_factor,
            fade_enabled:     () => vars.fade_enabled,
            fade_delay_ms:    () => vars.fade_delay_ms,
            fade_duration_ms: () => vars.fade_duration_ms,
            roll_timeout_ms: () => vars.roll_timeout_ms,
            rng_seed:        () => rngSeed,
        };
        return map[name] ? map[name]() : undefined;
    }

    // ---------------------------------------------------------------------
    // DICE BOX
    // ---------------------------------------------------------------------

    /**
     * Creates a new dice box.
     *
     * @param {HTMLElement} container
     *        Element which will contain the renderer canvas.
     */
    that.dice_box = function(container) {

        this.dices = [];

        this.scene = new THREE.Scene();
        this.world = new CANNON.World();

        /*
         * The original notation string is deliberately retained here.
         *
         * Parsing happens when a roll is requested. This means callers can
         * change the notation using setDice() without forcing a parse until
         * the next throw.
         */
        this.diceToRoll = '';

        this.container = container;

        this.renderer = window.WebGLRenderingContext
            ? new THREE.WebGLRenderer({
                antialias: true,
                alpha: true
            })
            : new THREE.CanvasRenderer({
                antialias: true,
                alpha: true
            });

        container.appendChild(this.renderer.domElement);

        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.setClearColor(0xffffff, 0);

        this.reinit(container);

        var box = this;
        
        var scheduleResize = function() {
        if (box._resizeScheduled) return;
            box._resizeScheduled = true;
            requestAnimationFrame(function() {
                box._resizeScheduled = false;
                box.reinit(box.container);
            });
        };

        if (typeof ResizeObserver !== 'undefined') {
            box._resizeObserver = new ResizeObserver(scheduleResize);
            box._resizeObserver.observe(container);
        } else {
            $t.bind(window, 'resize', scheduleResize);
        }

        /*
         * Physics world setup.
         */
        this.world.gravity.set(0, 0, -9.8 * 800);
        this.world.broadphase = new CANNON.NaiveBroadphase();
        this.world.solver.iterations = 16;

        /*
         * Ambient lighting.
         */
        var ambientLight = new THREE.AmbientLight(
            vars.ambient_light_color
        );
        this.scene.add(ambientLight);

        /*
         * Cannon materials.
         */
        this.dice_body_material = new CANNON.Material();
        var desk_body_material = new CANNON.Material();
        var barrier_body_material = new CANNON.Material();

        this._deskDiceContact = new CANNON.ContactMaterial(
            desk_body_material,
            this.dice_body_material,
            0.01,   // friction
            0.5     // restitution
        );
        this.world.addContactMaterial(this._deskDiceContact);

        this._barrierDiceContact = new CANNON.ContactMaterial(
            barrier_body_material,
            this.dice_body_material,
            0,
            1.0
        );
        this.world.addContactMaterial(this._barrierDiceContact);

        this._diceDiceContact = new CANNON.ContactMaterial(
            this.dice_body_material,
            this.dice_body_material,
            0,      // friction
            0.5     // restitution
        );
        this.world.addContactMaterial(this._diceDiceContact);

        /*
         * Desk.
         */
        this.world.add(
            new CANNON.RigidBody(
                0,
                new CANNON.Plane(),
                desk_body_material
            )
        );

        /*
         * Four invisible physics barriers around the dice tray.
         */
        var barrier;
        this._barriers =[];

        barrier = new CANNON.RigidBody(
            0,
            new CANNON.Plane(),
            barrier_body_material
        );
        barrier.quaternion.setFromAxisAngle(
            new CANNON.Vec3(1, 0, 0),
            Math.PI / 2
        );
        barrier.position.set(0, this.h * 0.93, 0);
        this.world.add(barrier);
        this._barriers.push(barrier);

        barrier = new CANNON.RigidBody(
            0,
            new CANNON.Plane(),
            barrier_body_material
        );
        barrier.quaternion.setFromAxisAngle(
            new CANNON.Vec3(1, 0, 0),
            -Math.PI / 2
        );
        barrier.position.set(0, -this.h * 0.93, 0);
        this.world.add(barrier);
        this._barriers.push(barrier);

        barrier = new CANNON.RigidBody(
            0,
            new CANNON.Plane(),
            barrier_body_material
        );
        barrier.quaternion.setFromAxisAngle(
            new CANNON.Vec3(0, 1, 0),
            -Math.PI / 2
        );
        barrier.position.set(this.w * 0.93, 0, 0);
        this.world.add(barrier);
        this._barriers.push(barrier);

        barrier = new CANNON.RigidBody(
            0,
            new CANNON.Plane(),
            barrier_body_material
        );
        barrier.quaternion.setFromAxisAngle(
            new CANNON.Vec3(0, 1, 0),
            Math.PI / 2
        );
        barrier.position.set(-this.w * 0.93, 0, 0);
        this.world.add(barrier);
        this._barriers.push(barrier);

        this.last_time = 0;
        this.running = false;

        this.renderer.render(
            this.scene,
            this.camera
        );

        this._onExplosion = null;
    };

    /**
     * Reinitialises camera, lighting and desk dimensions.
     *
     * Called during initialisation and whenever the container is resized.
     *
     * @param {HTMLElement} container
     */
    that.dice_box.prototype.reinit = function(container) {

        var newCw = container.clientWidth / 2;
        var newCh = container.clientHeight / 2;

        // Nothing meaningful changed — skip the expensive rebuild.
        if (this.camera && newCw === this.cw && newCh === this.ch) {
            return;
        }

        this.cw = newCw;
        this.ch = newCh;
        this.w = this.cw;
        this.h = this.ch;

        this.aspect = Math.min(
            this.cw / this.w,
            this.ch / this.h
        );

        // Only recompute the base scale when the container actually has a size.
        // If it's hidden (display:none, detached, mid-layout), leave the previous
        // values alone so a resize-while-hidden doesn't wipe a working scale.
        if (this.w > 0 && this.h > 0) {
            this._baseScale = Math.sqrt(this.w * this.w + this.h * this.h) / 8;
            applyScaleForCount(this, this._lastDiceCount || 0);
        }

        this.renderer.setSize(
            this.cw * 2,
            this.ch * 2
        );

        this.wh =
            this.ch /
            this.aspect /
            Math.tan(10 * Math.PI / 180);

        if (this.camera) {
            this.scene.remove(this.camera);
        }

        this.camera = new THREE.PerspectiveCamera(
            20,
            this.cw / this.ch,
            1,
            this.wh * 1.3
        );
        this.camera.position.z = this.wh;

        var mw = Math.max(
            this.w,
            this.h
        );

        if (this.light) {
            this.scene.remove(this.light);
        }

        this.light = new THREE.SpotLight(
            vars.spot_light_color,
            2.0
        );
        this.light.position.set(
            -mw / 2,
            mw / 2,
            mw * 2
        );
        this.light.target.position.set(
            0,
            0,
            0
        );
        this.light.distance = mw * 5;
        this.light.castShadow = true;
        this.light.shadowCameraNear = mw / 10;
        this.light.shadowCameraFar = mw * 5;
        this.light.shadowCameraFov = 50;
        this.light.shadowBias = 0.001;
        this.light.shadowDarkness = 1.1;
        this.light.shadowMapWidth = 1024;
        this.light.shadowMapHeight = 1024;
        this.scene.add(this.light);

        if (this.desk) {
            this.scene.remove(this.desk);
        }

        this.desk = new THREE.Mesh(
            new THREE.PlaneGeometry(
                this.w * 2,
                this.h * 2,
                1,
                1
            ),
            new THREE.MeshPhongMaterial({
                color: vars.desk_color,
                opacity: vars.desk_opacity,
                transparent: true
            })
        );
        this.desk.receiveShadow = vars.use_shadows;
        this.scene.add(this.desk);

        this._updateBarriers();

        this.renderer.render(
            this.scene,
            this.camera
        );
    };

    that.dice_box.prototype._updateBarriers = function() {
        if (!this._barriers || this._barriers.length !== 4) return;
        var hy = this.h * 0.93;
        var wx = this.w * 0.93;
        this._barriers[0].position.set(0,  hy, 0);   // +Y
        this._barriers[1].position.set(0, -hy, 0);   // -Y
        this._barriers[2].position.set( wx, 0, 0);   // +X
        this._barriers[3].position.set(-wx, 0, 0);   // -X
    };

    /**
     * Sets the dice notation to be rolled.
     *
     * The notation is intentionally stored as a string and parsed when the
     * roll begins.
     *
     * Examples:
     *
     *     box.setDice('1d20');
     *     box.setDice('3d6');
     *     box.setDice('2d20kh1');
     *     box.setDice('4d6dl1 + 5');
     *     box.setDice('2d6! + 1d20r1');
     *
     * @param {string} diceToRoll
     */
    that.dice_box.prototype.setDice = function(diceToRoll) {
        this.diceToRoll = diceToRoll;
    };

    /**
     * Sets the function to be called when a die explodes (if explosions are used).
     *
     * @param {function} callBackFunction
     */
    that.dice_box.prototype.setOnExplosion = function(callBackFunction) {
        this._onExplosion = callBackFunction;
    };

    /**
     * Starts a programmatic dice throw.
     *
     * @param {Function} before_roll
     *        Optional callback called after parsing but before physics begins.
     *        The callback receives the parsed notation object and may return
     *        an array of desired numeric dice results. This is useful when
     *        the application already has authoritative results and only wants
     *        the 3D dice to visually reproduce them.
     *        (For recursive rolls, only the first phase receives forced results.)
     *
     * @param {Function} after_roll
     *        Optional callback called after the physical roll has completed
     *        and the results have been evaluated.
     */
    that.dice_box.prototype.start_throw = function(options, before_roll, after_roll) {
        if (typeof options === 'function') {
            after_roll = before_roll;
            before_roll = options;
            options = {};
        }
        const opts = options || {};
        const box = this;

        return new Promise(function(resolve, reject) {
            if (box.rolling) {
                console.warn('Dice Roll: Already rolling, ignoring request.');
                reject(createDiceError('ROLL_IN_PROGRESS', 'A roll is already in progress.'));
                return;
            }

            var userAfter = after_roll;
            var wrappedAfter = function(notation) {
                if (userAfter) {
                    try {
                        userAfter(notation);
                    } catch (e) {
                        console.error('Dice Roll: Error in after_roll callback:', e);
                    }
                }
                if (notation && notation.error) {
                    reject(notation);
                } else {
                    resolve(notation);
                }
            };

            try {
                var vector = opts.vector || {
                    x: (rnd() * 2 - 1) * box.w,
                    y: -(rnd() * 2 - 1) * box.h
                };
                var dist = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
                var boost = opts.boost || (rnd() + 3) * dist;

                // Guard against a degenerate container/throw vector.
                if (!isFinite(dist) || dist === 0 || box.w === 0 || box.h === 0) {
                    var err = createDiceError(
                        'RENDER_FAILED',
                        'Container has no size or throw vector is degenerate.'
                    );
                    _handleDiceError(box, err, wrappedAfter, null);
                    return;
                }

                throw_dices(box, vector, boost, dist, before_roll, wrappedAfter);
            } catch (e) {
                var err = createDiceError('RENDER_FAILED', null, e);
                _handleDiceError(box, err, wrappedAfter, null);
            }
        });
    };

    /**
     * Rolls the dice with a random throw, optionally controlling the strength and direction.
     *
     * @param {Object} [options] - Configuration for the throw.
     * @param {number} [options.minBoost=2.0] - Minimum boost multiplier (relative to distance).
     * @param {number} [options.maxBoost=5.0] - Maximum boost multiplier.
     * @param {number} [options.angle] - Direction in radians (0 = right, π/2 = up). If omitted, random.
     * @param {Function} [before_roll] - Callback before the roll (receives notation, may return forced results).
     * @param {Function} [after_roll] - Callback after the roll (receives notation).
     * @returns {void}
     */
    that.dice_box.prototype.roll = function(options, before_roll, after_roll) {
        if (typeof options === 'function') {
            after_roll = before_roll;
            before_roll = options;
            options = {};
        }
        const opts = options || {};
        const minBoost = opts.minBoost !== undefined ? opts.minBoost : 2.0;
        const maxBoost = opts.maxBoost !== undefined ? opts.maxBoost : 5.0;
        const angle = opts.angle;
        const box = this;

        let vector;
        if (angle !== undefined) {
            vector = { x: Math.cos(angle) * box.w, y: -Math.sin(angle) * box.h };
        } else {
            vector = { x: (rnd() * 2 - 1) * box.w, y: -(rnd() * 2 - 1) * box.h };
        }
        const dist = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
        const boostFactor = rnd() * (maxBoost - minBoost) + minBoost;
        const boost = boostFactor * dist;

        return this.start_throw({ vector, boost }, before_roll, after_roll);
    };

    /**
     * Binds swipe gestures to a container.
     *
     * The swipe direction controls the direction of the throw.
     *
     * @param {HTMLElement} container
     * @param {Function} before_roll
     * @param {Function} after_roll
     */
    that.dice_box.prototype.bind_swipe = function(
        container,
        before_roll,
        after_roll
    ) {

        let box = this;

        $t.bind(
            container,
            ['mousedown', 'touchstart'],
            function(ev) {
                ev.preventDefault();
                box.mouse_time = (new Date()).getTime();
                box.mouse_start = $t.get_mouse_coords(ev);
            }
        );

        $t.bind(
            container,
            ['mouseup', 'touchend'],
            function(ev) {
                if (box.rolling) {
                    return;
                }
                if (box.mouse_start == undefined) {
                    return;
                }
                var m = $t.get_mouse_coords(ev);
                var vector = {
                    x: m.x - box.mouse_start.x,
                    y: -(m.y - box.mouse_start.y)
                };
                box.mouse_start = undefined;
                var dist = Math.sqrt(
                    vector.x * vector.x +
                    vector.y * vector.y
                );
                if (dist < Math.sqrt(box.w * box.h * 0.01)) {
                    return;
                }
                var time_int =
                    (new Date()).getTime() -
                    box.mouse_time;
                if (time_int > 2000) {
                    time_int = 2000;
                }
                var boost =
                    Math.sqrt(
                        (2500 - time_int) / 2500
                    ) *
                    dist *
                    2;
                box.start_throw({ vector, boost }, before_roll, after_roll);
            }
        );
    };

    // ---------------------------------------------------------------------
    // NOTATION PARSER (EXTENDED)
    // ---------------------------------------------------------------------

    /**
     * Parses a dice notation string with support for advanced rules.
     *
     * Supported rules (applied in order):
     *   - khN / klN / dhN / dlN  (keep/drop highest/lowest)
     *   - ! or !>N               (explode on max or >N)
     *   - !! or !!>N             (compounding explosion)
     *   - p                      (penetrating, WoD style – subtract 1 on each explosion)
     *   - rN or r>N              (reroll until success, condition value < N or >N)
     *   - roN or ro>N            (reroll exactly once)
     *   - er                     (explode & reroll 1s)
     *   - sa / sd                (sort ascending/descending)
     *   - cs>N                   (critical success if value > N)
     *   - cf<N                   (critical failure if value < N)
     *   - tN                     (count successes, value >= N)
     *   - fN                     (count failures, value < N)
     *
     * Rules are stored in a `rules` array on each group.
     *
     * @param {string} notation
     * @returns {Object} parsed notation object with `groups`, `set`, `constant`, `audit`, etc.
     */
    that.parse_notation = function(notation) {

        var ret = {
            groups: [],
            set: [],
            constant: 0,
            result: [],
            diceResults: [],
            resultTotal: 0,
            resultString: '',
            audit: [],      // will be populated during rolling
            auditString: '',
            error: false,
            errorCode: null,
            errorMessage: null,
            errorStack: null
        };

        var supportedDice = [
            'd4', 'd6', 'd8', 'd9', 'd10', 'd12', 'd20', 'd100'
        ];

        if (typeof notation !== 'string' || notation.trim().length === 0) {
            ret.error = true;
            ret.errorCode = 'EMPTY_NOTATION';
            ret.errorMessage = DICE_ERRORS.EMPTY_NOTATION;
            console.warn('Dice Roll: Empty or invalid notation string.');
            return ret;
        }

        // Remove @... part (legacy)
        var source = notation.split('@')[0].replace(/\s+/g, '');
        if (source.length === 0) {
            ret.error = true;
            ret.errorCode = 'EMPTY_NOTATION';
            ret.errorMessage = DICE_ERRORS.EMPTY_NOTATION;
            return ret;
        }

        var terms = source.split(/(?=[+-])/);

        for (var termIndex = 0; termIndex < terms.length; termIndex++) {
            var term = terms[termIndex];
            if (!term) continue;

            var sign = 1;
            if (term.charAt(0) === '+') {
                term = term.substring(1);
            } else if (term.charAt(0) === '-') {
                sign = -1;
                term = term.substring(1);
            }
            if (!term) continue;

            // ----- Dice term with advanced rules -----
            // We'll match: (count)d(sides)(rule1)(rule2)...
            // Rules are appended directly: e.g., 2d6!kh1, 4d6dl1!>4, 1d20r1
            // We'll parse by extracting the base dice part first, then the rules.
            var diceMatch = term.match(/^(\d*)d(\d+)/i);
            if (diceMatch) {
                var count = diceMatch[1] === '' ? 1 : parseInt(diceMatch[1], 10);
                var type = 'd' + diceMatch[2];
                var rulesStr = term.substring(diceMatch[0].length); // the rest

                if (sign < 0) {
                    ret.error = true;
                    ret.errorCode = 'NEGATIVE_DICE_TERM';
                    ret.errorMessage = DICE_ERRORS.NEGATIVE_DICE_TERM + ' (' + term + ')';
                    continue;
                }

                if (count <= 0) {
                    ret.error = true;
                    ret.errorCode = 'ZERO_DICE';
                    ret.errorMessage = DICE_ERRORS.ZERO_DICE;
                    continue;
                }

                if (supportedDice.indexOf(type) === -1) {
                    ret.error = true;
                    ret.errorCode = 'UNSUPPORTED_DIE';
                    ret.errorMessage = DICE_ERRORS.UNSUPPORTED_DIE + ' (' + type + ')';
                    continue;
                }

                // Parse rules from the suffix
                var rules = [];
                var remaining = rulesStr;

                // Operator + number matcher (order matters: >= and <= before > and <)
                var opNumRegex = /^(>=|<=|>|<|=)(\d+)/;

                while (remaining.length > 0) {
                    var matched = false;
                    var m;

                    // -------- khN, klN, dhN, dlN (keep/drop) --------
                    m = remaining.match(/^(kh|kl|dh|dl)(\d+)/i);
                    if (m) {
                        var ruleType = m[1].toLowerCase();
                        var countNum = parseInt(m[2], 10);
                        if (countNum > count) {
                            ret.error = true;
                            ret.errorCode = 'RULE_COUNT_EXCEEDS_DICE';
                            ret.errorMessage = DICE_ERRORS.RULE_COUNT_EXCEEDS_DICE + ' (' + countNum + ' > ' + count + ')';
                        }
                        var ruleMap = {
                            'kh': 'keep-highest',
                            'kl': 'keep-lowest',
                            'dh': 'drop-highest',
                            'dl': 'drop-lowest'
                        };
                        rules.push({ type: ruleMap[ruleType], count: countNum });
                        remaining = remaining.substring(m[0].length);
                        matched = true;
                        continue;
                    }

                    // -------- !! , !!<op>N , !!N (compounding explode) --------
                    if (remaining.startsWith('!!')) {
                        var rest = remaining.substring(2);
                        var opMatch = rest.match(opNumRegex);
                        if (opMatch) {
                            rules.push({
                                type: 'explode-compounding',
                                threshold: parseInt(opMatch[2], 10),
                                condition: operatorToCondition(opMatch[1])
                            });
                            remaining = rest.substring(opMatch[0].length);
                        } else {
                            var numMatch = rest.match(/^(\d+)/);
                            if (numMatch) {
                                rules.push({
                                    type: 'explode-compounding',
                                    threshold: parseInt(numMatch[1], 10),
                                    condition: 'greater-equal'
                                });
                                remaining = rest.substring(numMatch[0].length);
                            } else {
                                rules.push({ type: 'explode-compounding', threshold: 'max' });
                                remaining = rest;
                            }
                        }
                        matched = true;
                        continue;
                    }

                    // -------- ! , !<op>N , !N (explode) --------
                    if (remaining.startsWith('!')) {
                        var rest = remaining.substring(1);
                        var opMatch = rest.match(opNumRegex);
                        if (opMatch) {
                            rules.push({
                                type: 'explode',
                                threshold: parseInt(opMatch[2], 10),
                                condition: operatorToCondition(opMatch[1])
                            });
                            remaining = rest.substring(opMatch[0].length);
                        } else {
                            var numMatch = rest.match(/^(\d+)/);
                            if (numMatch) {
                                rules.push({
                                    type: 'explode',
                                    threshold: parseInt(numMatch[1], 10),
                                    condition: 'greater-equal'
                                });
                                remaining = rest.substring(numMatch[0].length);
                            } else {
                                rules.push({ type: 'explode', threshold: 'max' });
                                remaining = rest;
                            }
                        }
                        matched = true;
                        continue;
                    }

                    // -------- p (penetrating) --------
                    if (remaining.startsWith('p')) {
                        rules.push({ type: 'penetrate' });
                        remaining = remaining.substring(1);
                        matched = true;
                        continue;
                    }

                    // -------- ro<op>N , roN (reroll once) --------
                    if (remaining.startsWith('ro')) {
                        var rest = remaining.substring(2);
                        var opMatch = rest.match(opNumRegex);
                        if (opMatch) {
                            rules.push({
                                type: 'reroll',
                                threshold: parseInt(opMatch[2], 10),
                                condition: operatorToCondition(opMatch[1]),
                                once: true
                            });
                            remaining = rest.substring(opMatch[0].length);
                            matched = true;
                            continue;
                        }
                        var numMatch = rest.match(/^(\d+)/);
                        if (numMatch) {
                            rules.push({
                                type: 'reroll',
                                threshold: parseInt(numMatch[1], 10),
                                condition: 'less-than',
                                once: true
                            });
                            remaining = rest.substring(numMatch[0].length);
                            matched = true;
                            continue;
                        }
                    }

                    // -------- r<op>N , rN (reroll until success) --------
                    if (remaining.startsWith('r') && !remaining.startsWith('ro')) {
                        var rest = remaining.substring(1);
                        var opMatch = rest.match(opNumRegex);
                        if (opMatch) {
                            rules.push({
                                type: 'reroll',
                                threshold: parseInt(opMatch[2], 10),
                                condition: operatorToCondition(opMatch[1]),
                                once: false
                            });
                            remaining = rest.substring(opMatch[0].length);
                            matched = true;
                            continue;
                        }
                        var numMatch = rest.match(/^(\d+)/);
                        if (numMatch) {
                            rules.push({
                                type: 'reroll',
                                threshold: parseInt(numMatch[1], 10),
                                condition: 'less-than',
                                once: false
                            });
                            remaining = rest.substring(numMatch[0].length);
                            matched = true;
                            continue;
                        }
                    }

                    // -------- er (explode & reroll 1s) --------
                    if (remaining.startsWith('er')) {
                        rules.push({
                            type: 'reroll',
                            threshold: 1,
                            condition: 'less-than',
                            once: false
                        });
                        rules.push({ type: 'explode', threshold: 'max' });
                        remaining = remaining.substring(2);
                        matched = true;
                        continue;
                    }

                    // -------- sa / sd (sort) --------
                    if (remaining.startsWith('sa')) {
                        rules.push({ type: 'sort-ascending' });
                        remaining = remaining.substring(2);
                        matched = true;
                        continue;
                    }
                    if (remaining.startsWith('sd')) {
                        rules.push({ type: 'sort-descending' });
                        remaining = remaining.substring(2);
                        matched = true;
                        continue;
                    }

                    // -------- cs<op>N , csN (critical success) --------
                    if (remaining.startsWith('cs')) {
                        var rest = remaining.substring(2);
                        var opMatch = rest.match(opNumRegex);
                        if (opMatch) {
                            rules.push({
                                type: 'critical-success',
                                threshold: parseInt(opMatch[2], 10),
                                condition: operatorToCondition(opMatch[1])
                            });
                            remaining = rest.substring(opMatch[0].length);
                            matched = true;
                            continue;
                        }
                        var numMatch = rest.match(/^(\d+)/);
                        if (numMatch) {
                            rules.push({
                                type: 'critical-success',
                                threshold: parseInt(numMatch[1], 10),
                                condition: 'greater-than'
                            });
                            remaining = rest.substring(numMatch[0].length);
                            matched = true;
                            continue;
                        }
                    }

                    // -------- cf<op>N , cfN (critical failure) --------
                    if (remaining.startsWith('cf')) {
                        var rest = remaining.substring(2);
                        var opMatch = rest.match(opNumRegex);
                        if (opMatch) {
                            rules.push({
                                type: 'critical-failure',
                                threshold: parseInt(opMatch[2], 10),
                                condition: operatorToCondition(opMatch[1])
                            });
                            remaining = rest.substring(opMatch[0].length);
                            matched = true;
                            continue;
                        }
                        var numMatch = rest.match(/^(\d+)/);
                        if (numMatch) {
                            rules.push({
                                type: 'critical-failure',
                                threshold: parseInt(numMatch[1], 10),
                                condition: 'less-than'
                            });
                            remaining = rest.substring(numMatch[0].length);
                            matched = true;
                            continue;
                        }
                    }

                    // -------- t<op>N , tN (target number) --------
                    if (remaining.startsWith('t')) {
                        var rest = remaining.substring(1);
                        var opMatch = rest.match(opNumRegex);
                        if (opMatch) {
                            rules.push({
                                type: 'target-number',
                                threshold: parseInt(opMatch[2], 10),
                                condition: operatorToCondition(opMatch[1])
                            });
                            remaining = rest.substring(opMatch[0].length);
                            matched = true;
                            continue;
                        }
                        var numMatch = rest.match(/^(\d+)/);
                        if (numMatch) {
                            rules.push({
                                type: 'target-number',
                                threshold: parseInt(numMatch[1], 10),
                                condition: 'greater-equal'
                            });
                            remaining = rest.substring(numMatch[0].length);
                            matched = true;
                            continue;
                        }
                    }

                    // -------- f<op>N , fN (failures) --------
                    if (remaining.startsWith('f')) {
                        var rest = remaining.substring(1);
                        var opMatch = rest.match(opNumRegex);
                        if (opMatch) {
                            rules.push({
                                type: 'failures',
                                threshold: parseInt(opMatch[2], 10),
                                condition: operatorToCondition(opMatch[1])
                            });
                            remaining = rest.substring(opMatch[0].length);
                            matched = true;
                            continue;
                        }
                        var numMatch = rest.match(/^(\d+)/);
                        if (numMatch) {
                            rules.push({
                                type: 'failures',
                                threshold: parseInt(numMatch[1], 10),
                                condition: 'less-than'
                            });
                            remaining = rest.substring(numMatch[0].length);
                            matched = true;
                            continue;
                        }
                    }

                    // If nothing matched, break to avoid infinite loop
                    if (!matched) {
                        ret.error = true;
                        ret.errorCode = 'INVALID_RULE';
                        ret.errorMessage = DICE_ERRORS.INVALID_RULE +
                            ' (unrecognised rule "' + remaining + '"). ' +
                            'Expected one of: khN klN dhN dlN, ! !<op>N !N, !! !!<op>N !!N, p, ' +
                            'r<op>N rN, ro<op>N roN, er, sa, sd, cs<op>N csN, cf<op>N cfN, ' +
                            't<op>N tN, f<op>N fN (where <op> is one of >, >=, <, <=, =)';
                        console.warn('Dice Roll: Unrecognised rule suffix:', remaining);
                        break;
                    }
                }

                // Create the group
                var group = {
                    id: ret.groups.length,
                    count: count,
                    type: type,
                    rules: rules,
                    visual: null,
                    isCompound: (type === 'd100' && vars.d100_compound)
                };

                ret.groups.push(group);

                // Maintain flattened set (for backward compatibility)
                if (group.isCompound) {
                    for (var i = 0; i < count; i++) {
                        ret.set.push('d100');
                        ret.set.push('d10');
                    }
                } else {
                    for (var i = 0; i < count; i++) {
                        ret.set.push(type);
                    }
                }

                continue;
            }

            // Constant term
            var constantMatch = term.match(/^\d+$/);
            if (constantMatch) {
                ret.constant += sign * parseInt(term, 10);
                continue;
            }

            // Unrecognised
            ret.error = true;
            ret.errorCode = 'INVALID_NOTATION';
            ret.errorMessage = DICE_ERRORS.INVALID_NOTATION + ' (unrecognised term "' + term + '")';
            console.warn('Dice Roll: Unrecognised term:', term);
        }

        if (ret.set.length === 0) {
            ret.error = true;
            ret.errorCode = 'NO_DICE';
            ret.errorMessage = DICE_ERRORS.NO_DICE;
            console.warn('Dice Roll: No dice in notation (constant-only expressions are not allowed).');
        }

        if (ret.error) {
            console.warn('Dice Roll: Notation parse had errors. Results may be incomplete.');
        }

        return ret;
    };

    /**
     * Converts a parsed notation object back into dice notation.
     * This serializes the rules array.
     *
     * @param {Object} nn - parsed notation object
     * @returns {string}
     */
    that.stringify_notation = function(nn) {
        var notation = '';

        if (nn && Array.isArray(nn.groups) && nn.groups.length) {
            for (var i = 0; i < nn.groups.length; i++) {
                var group = nn.groups[i];
                if (notation.length) notation += ' + ';

                if (group.count !== 1) notation += group.count;
                notation += group.type;

                // Serialize rules in order
                if (group.rules && group.rules.length) {
                    for (var r = 0; r < group.rules.length; r++) {
                        var rule = group.rules[r];
                        switch (rule.type) {
                            case 'keep-highest': notation += 'kh' + rule.count; break;
                            case 'keep-lowest': notation += 'kl' + rule.count; break;
                            case 'drop-highest': notation += 'dh' + rule.count; break;
                            case 'drop-lowest': notation += 'dl' + rule.count; break;
                            case 'explode':
                                if (rule.threshold === 'max') notation += '!';
                                else notation += '!' + conditionToString(rule.condition || 'greater-than', rule.threshold);
                                break;
                            case 'explode-compounding':
                                if (rule.threshold === 'max') notation += '!!';
                                else notation += '!!' + conditionToString(rule.condition || 'greater-than', rule.threshold);
                                break;
                            case 'penetrate': notation += 'p'; break;
                            case 'reroll':
                                var prefix = rule.once ? 'ro' : 'r';
                                notation += prefix + conditionToString(rule.condition || 'less-than', rule.threshold);
                                break;
                            case 'sort-ascending': notation += 'sa'; break;
                            case 'sort-descending': notation += 'sd'; break;
                            case 'critical-success':
                                notation += 'cs' + conditionToString(rule.condition || 'greater-than', rule.threshold);
                                break;
                            case 'critical-failure':
                                notation += 'cf' + conditionToString(rule.condition || 'less-than', rule.threshold);
                                break;
                            case 'target-number':
                                notation += 't' + conditionToString(rule.condition || 'greater-equal', rule.threshold);
                                break;
                            case 'failures':
                                notation += 'f' + conditionToString(rule.condition || 'less-than', rule.threshold);
                                break;

                            default: break;
                        }
                    }
                }
            }
        } else {
            // Legacy fallback
            var dict = {};
            for (var i = 0; i < nn.set.length; i++) {
                if (!dict[nn.set[i]]) dict[nn.set[i]] = 1;
                else ++dict[nn.set[i]];
            }
            for (var type in dict) {
                if (notation.length) notation += ' + ';
                notation += (dict[type] > 1 ? dict[type] : '') + type;
            }
        }

        if (nn.constant) {
            if (notation.length) {
                if (nn.constant > 0) notation += ' + ' + nn.constant;
                else notation += ' - ' + Math.abs(nn.constant);
            } else {
                notation += nn.constant;
            }
        }

        return notation;
    };

    // ---------------------------------------------------------------------
    // AUDIT SYSTEM
    // ---------------------------------------------------------------------

    /**
     * Logs an event to the audit trail.
     *
     * @param {Array} audit - The audit array.
     * @param {number} phase - Recursion depth (0 for initial).
     * @param {string} type - Event type (parse, roll, drop, keep, explode, reroll, sort, final, etc.).
     * @param {string} description - Human‑readable description (can be a template).
     * @param {Object} [details] - Structured data (dice IDs, values, rule, etc.).
     */
    function logEvent(audit, phase, type, description, details) {
        var step = audit.length;
        audit.push({
            step: step,
            phase: phase,
            type: type,
            description: description,
            details: details || {}
        });
    }

    /**
     * Renders the audit trail as a natural language string.
     *
     * @param {Array} audit
     * @returns {string}
     */
    that.formatAudit = function(audit) {
        var lines = [];
        for (var i = 0; i < audit.length; i++) {
            var entry = audit[i];
            var line = 'Step ' + entry.step + ': ' + entry.description;
            lines.push(line);
        }
        return lines.join('\n');
    };

    // ---------------------------------------------------------------------
    // DICE VALUE HELPERS
    // ---------------------------------------------------------------------

    /**
     * Returns a random face value for a given die type (logical, not physical).
     *
     * @param {string} type - e.g., 'd6', 'd20'
     * @returns {number} - value in the appropriate range (d10 returns 1-10, d9 returns 0-9? We'll treat d9 as 0-9 for consistency)
     */
    function roll_die_value(type) {
        var range = CONSTS.dice_face_range[type];
        if (!range) return 0;
        var val = Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0];
        // For d10, convert 0 to 10 (public notation)
        if (type === 'd10' && val === 0) val = 10;
        // For d9, convert 0 to 9
        if (type === 'd9' && val === 0) val = 9;
        // d100 tens digit returns 0-9, but combined later
        return val;
    }

    /**
     * Returns the maximum logical value of a die type.
     */
    function die_max_value(type) {
        var range = CONSTS.dice_face_range[type];
        if (!range) return 0;
        // For d10 we want 10, not 9
        if (type === 'd10') return 10;
        if (type === 'd9') return 9;
        return range[1];
    }

    /**
     * Checks if a die value should explode based on the rule.
     */
    function should_explode(value, rule) {
        if (rule.threshold === 'max') {
            // We need the type; we'll pass type separately.
            return false; // will be handled by caller with type
        }
        if (rule.condition === 'greater-than') {
            return value > rule.threshold;
        }
        return false;
    }

    /**
     * Checks if a die should be rerolled.
     */
    function should_reroll(value, rule) {
        if (rule.condition === 'less-than') {
            return value < rule.threshold;
        } else if (rule.condition === 'greater-than') {
            return value > rule.threshold;
        }
        return false;
    }

    // ---------------------------------------------------------------------
    // RECURSIVE ROLL ENGINE
    // ---------------------------------------------------------------------

    /**
     * Builds the next notation object from dice that need to be re‑rolled
     * (explosions or rerolls).
     *
     * @param {Array} explodedDice - Array of combined dice that exploded.
     * @param {Array} rerolledDice - Array of combined dice that need reroll.
     * @param {Object} originalNotation - The parsed notation for this phase.
     * @returns {Object} A new parsed notation object (groups only, no constant).
     */
    function build_next_notation(explodedDice, rerolledDice, originalNotation) {
        var allDice = explodedDice.concat(rerolledDice);
        if (allDice.length === 0) return null;

        var groupsMap = {};
        for (var i = 0; i < allDice.length; i++) {
            var die = allDice[i];
            var gid = die.groupId;
            if (!groupsMap[gid]) {
                // Find the original group definition
                var origGroup = null;
                for (var j = 0; j < originalNotation.groups.length; j++) {
                    if (originalNotation.groups[j].id === gid) {
                        origGroup = originalNotation.groups[j];
                        break;
                    }
                }
                if (!origGroup) continue;
                // Determine the original group ID for colour inheritance
                var originalId = origGroup.originalGroupId !== undefined ? origGroup.originalGroupId : origGroup.id;
                groupsMap[gid] = {
                    id: Object.keys(groupsMap).length,
                    count: 0,
                    type: origGroup.type,
                    rules: origGroup.rules.slice(),
                    isCompound: origGroup.isCompound,
                    visual: origGroup.visual ? JSON.parse(JSON.stringify(origGroup.visual)) : null,
                    originalGroupId: originalId   // propagate original ID
                };
            }
            groupsMap[gid].count++;
        }

        var newGroups = Object.values(groupsMap);
        return {
            groups: newGroups,
            set: [], // will be filled later by generate_vectors
            constant: 0,
            error: false,
            // also copy other fields if needed
        };
    }

    /**
     * Finds a group definition by id.
     */
    function findGroupById(notation, groupId) {
        for (var i = 0; i < notation.groups.length; i++) {
            if (notation.groups[i].id === groupId) return notation.groups[i];
        }
        return null;
    }

    /**
     * Applies static rules (keep/drop, sort) to the combined results.
     * This mutates the 'kept' flag and may reorder.
     * Also logs events to audit.
     */
    function apply_static_rules(notation, combinedResults, audit, phase) {
        // Group by groupId
        var groups = {};
        for (var i = 0; i < combinedResults.length; i++) {
            var r = combinedResults[i];
            if (!groups[r.groupId]) groups[r.groupId] = [];
            groups[r.groupId].push(r);
        }

        for (var gid in groups) {
            var groupDice = groups[gid];
            var groupDef = findGroupById(notation, parseInt(gid, 10));
            if (!groupDef) continue;

            var originalGroupId = groupDef.originalGroupId !== undefined ? groupDef.originalGroupId : groupDef.id;
            for (var d = 0; d < groupDice.length; d++) {
                groupDice[d].originalGroupId = originalGroupId;
            }

            var rules = groupDef.rules || [];
            // We only apply static rules here; dynamic ones (explode, reroll) are handled elsewhere.
            for (var ri = 0; ri < rules.length; ri++) {
                var rule = rules[ri];
                var type = rule.type;
                var count = rule.count || 0;

                // Keep/Drop
                if (type === 'keep-highest' || type === 'keep-lowest' ||
                    type === 'drop-highest' || type === 'drop-lowest') {
                    // Sort by value ascending, tie by diceId
                    var sorted = groupDice.slice().sort(function(a, b) {
                        if (a.value !== b.value) return a.value - b.value;
                        return a.diceId - b.diceId;
                    });

                    // Mark all as not kept first? Actually we'll apply selectively
                    // For keep rules, we start with all false, then set kept true for selected.
                    // For drop rules, we start with all true, then set kept false for selected.
                    var keepMode = (type === 'keep-highest' || type === 'keep-lowest');
                    if (keepMode) {
                        for (var d = 0; d < groupDice.length; d++) groupDice[d].kept = false;
                        var numToKeep = Math.min(count, sorted.length);
                        if (type === 'keep-highest') {
                            for (var d = sorted.length - 1; d >= sorted.length - numToKeep; d--) {
                                if (d >= 0) sorted[d].kept = true;
                            }
                        } else { // keep-lowest
                            for (var d = 0; d < numToKeep; d++) {
                                sorted[d].kept = true;
                            }
                        }
                    } else { // drop
                        // Initially all kept
                        for (var d = 0; d < groupDice.length; d++) groupDice[d].kept = true;
                        var numToDrop = Math.min(count, sorted.length);
                        if (type === 'drop-highest') {
                            for (var d = sorted.length - 1; d >= sorted.length - numToDrop; d--) {
                                if (d >= 0) sorted[d].kept = false;
                            }
                        } else { // drop-lowest
                            for (var d = 0; d < numToDrop; d++) {
                                sorted[d].kept = false;
                            }
                        }
                    }

                    // Log the action
                    var keptIds = groupDice.filter(d => d.kept).map(d => d.diceId);
                    var droppedIds = groupDice.filter(d => !d.kept).map(d => d.diceId);
                    var desc = '';
                    if (keepMode) {
                        desc = 'Kept ' + keptIds.length + ' die (IDs: ' + keptIds.join(', ') + ') with rule "' + type + '".';
                    } else {
                        desc = 'Dropped ' + droppedIds.length + ' die (IDs: ' + droppedIds.join(', ') + ') with rule "' + type + '".';
                    }
                    logEvent(audit, phase, type, desc, { rule: type, count: count, kept: keptIds, dropped: droppedIds });
                }

                // Sorting
                if (type === 'sort-ascending') {
                    groupDice.sort(function(a, b) {
                        if (a.value !== b.value) return a.value - b.value;
                        return a.diceId - b.diceId;
                    });
                    logEvent(audit, phase, 'sort', 'Sorted dice ascending.', { rule: 'sort-ascending' });
                }
                if (type === 'sort-descending') {
                    groupDice.sort(function(a, b) {
                        if (a.value !== b.value) return b.value - a.value;
                        return a.diceId - b.diceId;
                    });
                    logEvent(audit, phase, 'sort', 'Sorted dice descending.', { rule: 'sort-descending' });
                }

                // Critical success/failure – just set flags on the die object
                if (type === 'critical-success') {
                    var csCond = rule.condition || 'greater-than';
                    for (var d = 0; d < groupDice.length; d++) {
                        if (compareValues(groupDice[d].value, csCond, rule.threshold)) {
                            groupDice[d].critical = true;
                        }
                    }
                    logEvent(audit, phase, 'critical', 'Marked critical successes (' + conditionToString(csCond, rule.threshold) + ').', { rule: type, threshold: rule.threshold, condition: csCond });
                }
                if (type === 'critical-failure') {
                    var cfCond = rule.condition || 'less-than';
                    for (var d = 0; d < groupDice.length; d++) {
                        if (compareValues(groupDice[d].value, cfCond, rule.threshold)) {
                            groupDice[d].critical = true;
                            groupDice[d].failure = true;
                        }
                    }
                    logEvent(audit, phase, 'critical', 'Marked critical failures (' + conditionToString(cfCond, rule.threshold) + ').', { rule: type, threshold: rule.threshold, condition: cfCond });
                }

                if (type === 'target-number') {
                    notation._targetThreshold = rule.threshold;
                    notation._targetCondition = rule.condition || 'greater-equal';
                    logEvent(audit, phase, 'target', 'Success count for values ' + conditionToString(notation._targetCondition, rule.threshold) + '.', { rule: type, threshold: rule.threshold, condition: notation._targetCondition });
                }
                if (type === 'failures') {
                    notation._failureThreshold = rule.threshold;
                    notation._failureCondition = rule.condition || 'less-than';
                    logEvent(audit, phase, 'failures', 'Failure count for values ' + conditionToString(notation._failureCondition, rule.threshold) + '.', { rule: type, threshold: rule.threshold, condition: notation._failureCondition });
                }
            }
        }
    }

    function sortKeptDice(kept, notation) {
        if (!notation || !notation.groups) return kept;

        var groups = {};
        for (var i = 0; i < kept.length; i++) {
            var die = kept[i];
            var gid = die.originalGroupId !== undefined ? die.originalGroupId : die.groupId;
            if (!groups[gid]) groups[gid] = [];
            groups[gid].push(die);
        }

        var ordered = [];

        for (var gi = 0; gi < notation.groups.length; gi++) {
            var group = notation.groups[gi];
            var gid = group.originalGroupId !== undefined ? group.originalGroupId : group.id;
            var dice = groups[gid];
            if (!dice) continue;

            // Find the last sort rule for this group
            var sortRule = null;
            if (group.rules) {
                for (var ri = 0; ri < group.rules.length; ri++) {
                    var r = group.rules[ri];
                    if (r.type === 'sort-ascending' || r.type === 'sort-descending') {
                        sortRule = r;
                    }
                }
            }

            if (sortRule) {
                if (sortRule.type === 'sort-ascending') {
                    dice.sort(function(a, b) {
                        return a.value - b.value || a.diceId - b.diceId;
                    });
                } else {
                    dice.sort(function(a, b) {
                        return b.value - a.value || a.diceId - b.diceId;
                    });
                }
            }

            for (var d = 0; d < dice.length; d++) ordered.push(dice[d]);
            delete groups[gid];
        }

        // Append any remaining dice (shouldn't normally happen)
        for (var gid in groups) {
            for (var d = 0; d < groups[gid].length; d++) ordered.push(groups[gid][d]);
        }

        return ordered;
    }

    /**
     * Runs a single physics phase for the given vectors and calls callback with raw results.
     */
    function _run_physics_phase(box, vectors, callback) {
        box.prepare_dices_for_roll(vectors);

        // Simulate until stopped
        box.iteration = 0;
        while (!box.check_if_throw_finished()) {
            ++box.iteration;
            box.world.step(vars.frame_rate);
        }

        var rawResults = get_dice_values(box.dices);
        callback(rawResults);
    }

    /**
     * Recursive roll processor
     *
     * @param {Object} box                     - dice_box instance
     * @param {Object} parsedNotation          - notation for this phase
     * @param {number} accumulatedTotal        - total from previous phases
     * @param {number} depth                   - current recursion depth
     * @param {number} maxDepth                - safety limit
     * @param {Object} vector                  - throw direction (normalised)
     * @param {number} boost                   - throw strength
     * @param {Array}  forcedResults           - optional forced values for first phase (from before_roll)
     * @param {Function} finalCallback         - called when entire roll is done
     * @param {Array}  audit                   - shared audit array
     * @param {Array}  keptAccum               - accumulated kept dice across phases
     */
    function _process_recursive_roll(
        box,
        parsedNotation,
        accumulatedTotal,
        depth,
        maxDepth,
        vector,
        boost,
        forcedResults,
        finalCallback,
        audit,
        keptAccum
    ) {
        if (depth > maxDepth) {
            var err = createDiceError('RECURSION_DEPTH_EXCEEDED', 'Max recursion depth reached (' + maxDepth + ').');
            parsedNotation.error = true;
            parsedNotation.errorCode = err.code;
            parsedNotation.errorMessage = err.userMessage;
            parsedNotation.errorStack = err.stack;
            finalCallback(parsedNotation);
            return;
        }

        // Check total dice limit
        var totalDiceCount = 0;
        for (var gi = 0; gi < parsedNotation.groups.length; gi++) {
            totalDiceCount += parsedNotation.groups[gi].count;
        }
        if (keptAccum.length + totalDiceCount > vars.max_dice_per_roll) {
            var err = createDiceError('TOO_MANY_DICE', 'Exceeded safety limit of ' + vars.max_dice_per_roll + ' dice.');
            parsedNotation.error = true;
            parsedNotation.errorCode = err.code;
            parsedNotation.errorMessage = err.userMessage;
            parsedNotation.errorStack = err.stack;
            finalCallback(parsedNotation);
            return;
        }

        // Generate vectors for this phase
        var vectors = box.generate_vectors(parsedNotation, vector, boost);

        // We need to pass the forced results only for the first phase (depth === 0)
        var phaseForced = (depth === 0) ? forcedResults : null;

        // Use box._roll_phase to animate this phase
        box._roll_phase(vectors, phaseForced, function(rawResults) {
            try{
                // Combine compound dice
                var combined = combine_compound_results(rawResults, box.dices);

                // Log roll event
                var vals = combined.map(d => d.value).join(', ');
                logEvent(audit, depth, 'roll', 'Rolled ' + combined.length + ' dice: ' + vals + '.', { dice: combined.map(d => ({id: d.diceId, value: d.value})) });

                // Apply static rules (keep/drop, sort, criticals)
                apply_static_rules(parsedNotation, combined, audit, depth);
                apply_dropped_visuals_to_compound(combined, box.dices);
                apply_result_highlights(box, combined);
                box.renderer.render(box.scene, box.camera);   

                // Process dynamic rules (explode, reroll) – these may generate new dice
                var phaseTotal = 0;
                var explodedDice = [];
                var rerolledDice = [];

                for (var i = 0; i < combined.length; i++) {
                    var die = combined[i];
                    if (!die.kept) continue;

                    phaseTotal += die.value;

                    var groupDef = findGroupById(parsedNotation, die.groupId);
                    if (!groupDef) continue;

                    for (var ri = 0; ri < groupDef.rules.length; ri++) {
                        var rule = groupDef.rules[ri];

                        // Explosion
                        if (rule.type === 'explode' || rule.type === 'explode-compounding') {
                            var maxVal = die_max_value(die.type);
                            var explodeCondition = false;
                            if (rule.threshold === 'max') {
                                if (die.value === maxVal) explodeCondition = true;
                            } else {
                                var explodeOp = rule.condition || 'greater-than';
                                if (compareValues(die.value, explodeOp, rule.threshold)) explodeCondition = true;
                            }
                            if (explodeCondition) {
                                explodedDice.push(die);
                                var mesh = box.dices.find(d => d.dice_id === die.diceId);
                                if (mesh) apply_explosion_highlight(mesh);
                                logEvent(audit, depth, 'explode', 'Die #' + die.diceId + ' (value ' + die.value + ') exploded.', { diceId: die.diceId, value: die.value, rule: rule.type });
                            }
                        }

                        // Reroll
                        if (rule.type === 'reroll') {
                            var rerollOp = rule.condition || 'less-than';
                            if (compareValues(die.value, rerollOp, rule.threshold)) {
                                die.kept = false;
                                phaseTotal -= die.value;
                                rerolledDice.push(die);
                                logEvent(audit, depth, 'reroll', 'Die #' + die.diceId + ' (value ' + die.value + ') will be rerolled.', { diceId: die.diceId, value: die.value, rule: rule.type });
                            }
                        }

                        // Penetrate
                        if (rule.type === 'penetrate') {
                            if (die.value >= 10) {
                                die._penetrate = true;
                                explodedDice.push(die);
                                logEvent(audit, depth, 'penetrate', 'Die #' + die.diceId + ' (value ' + die.value + ') penetrated.', { diceId: die.diceId, value: die.value });
                            }
                        }
                    }

                    if (explodedDice.length > 0) {
                        box.renderer.render(box.scene, box.camera);
                    }
                }

                // Accumulate kept dice
                var keptThisPhase = combined.filter(d => d.kept);
                keptAccum.push.apply(keptAccum, keptThisPhase);

                // Build next notation
                var nextNotation = build_next_notation(explodedDice, rerolledDice, parsedNotation);

                if (!nextNotation || nextNotation.groups.length === 0) {
                    // No more dice – finalise
                    _finalise_roll(box, parsedNotation, accumulatedTotal + phaseTotal, finalCallback, keptAccum, audit);
                } else {
                    // Recurse – note: we do NOT call box.clear() because box.roll will clear on next call
                    var newTotal = accumulatedTotal + phaseTotal;
                    // If there were explosions, notify and delay
                    var delay = (explodedDice.length > 0) ? vars.explosion_delay_ms : 0;
                    if (explodedDice.length > 0 && box._onExplosion) {
                        box._onExplosion({
                            explodedDice: explodedDice,
                            phase: depth,
                            nextNotation: nextNotation
                        });
                    }
                    try {
                        if (delay > 0) {
                            setTimeout(function() {
                                _process_recursive_roll(
                                    box,
                                    nextNotation,
                                    newTotal,
                                    depth + 1,
                                    maxDepth,
                                    vector,
                                    boost,
                                    null,               // no forced results for subsequent phases
                                    finalCallback,
                                    audit,
                                    keptAccum
                                );
                            }, delay);
                        } else {
                            _process_recursive_roll(
                                    box,
                                    nextNotation,
                                    newTotal,
                                    depth + 1,
                                    maxDepth,
                                    vector,
                                    boost,
                                    null,               // no forced results for subsequent phases
                                    finalCallback,
                                    audit,
                                    keptAccum
                                );
                        }
                    } catch(e) {
                        var err = createDiceError('UNKNOWN_ERROR', null, e);
                        _handleDiceError(box, err, finalCallback, parsedNotation);
                    }
                }
            } catch (e) {
                var err = createDiceError('UNKNOWN_ERROR', null, e);
                _handleDiceError(box, err, finalCallback, parsedNotation);
            }
        });
    }

    /**
     * Finalises the roll and calls the after_roll callback.
     */
    function _finalise_roll(box, lastNotation, finalTotal, afterRollCb, keptAccum, audit) {
        // Determine result type based on rules
        var targetThreshold = lastNotation._targetThreshold;
        var failureThreshold = lastNotation._failureThreshold;

        var finalValue = finalTotal;
        var successCount = 0;
        var failureCount = 0;

        if (targetThreshold !== undefined) {
            var targetOp = lastNotation._targetCondition || 'greater-equal';
            for (var i = 0; i < keptAccum.length; i++) {
                if (compareValues(keptAccum[i].value, targetOp, targetThreshold)) successCount++;
            }
            finalValue = successCount;
        } else if (failureThreshold !== undefined) {
            var failOp = lastNotation._failureCondition || 'less-than';
            for (var i = 0; i < keptAccum.length; i++) {
                if (compareValues(keptAccum[i].value, failOp, failureThreshold)) failureCount++;
            }
            finalValue = failureCount;
        } else {
            // Sum of kept dice
            // finalTotal already includes all kept dice from all phases
            finalValue = finalTotal;
        }

        // Build result string
        var values = keptAccum.map(d => d.value);
        if (box._originalNotation) {
            keptAccum = sortKeptDice(keptAccum, box._originalNotation);
        }
        var resultString = values.join(' ');
        if (lastNotation.constant) {
            if (lastNotation.constant > 0) resultString += ' +' + lastNotation.constant;
            else resultString += ' -' + Math.abs(lastNotation.constant);
        }
        if (values.length > 1 || lastNotation.constant) {
            resultString += ' = ' + finalValue;
        }

        var notation = {
            groups: lastNotation.groups,
            set: lastNotation.set,
            constant: lastNotation.constant || 0,
            result: keptAccum.map(d => d.value),
            diceResults: keptAccum,
            resultTotal: finalValue,
            resultString: resultString,
            audit: audit,
            auditString: that.formatAudit(audit),
            error: false
        };
        console.log('Dice Roll: Final result:', notation.resultString, 'Total:', notation.resultTotal, 'Full Result:', notation);

        box.rolling = false;
        _clearRollWatchdog(box);
        try {
            if (afterRollCb) afterRollCb(notation);
        } catch (e) {
            var err = createDiceError('CALLBACK_ERROR', 'Error in after_roll callback', e);
            _handleDiceError(box, err, afterRollCb, notation);
        }
        box._scheduleFade();
    }

    // ---------------------------------------------------------------------
    // MAIN THROW FUNCTION (modified to branch)
    // ---------------------------------------------------------------------

    function throw_dices(
        box,
        vector,
        boost,
        dist,
        before_roll,
        after_roll
    ) {

        var uat = vars.use_adaptive_timestep;

        // Normalise vector
        vector.x /= dist;
        vector.y /= dist;

        // Parse notation
        var notation = that.parse_notation(box.diceToRoll);
        applyScaleForCount(box, notation.set.length);
        box._originalNotation = notation;

        if (notation.error) {
            if (after_roll) after_roll(notation);
            return;
        }

        if (notation.set.length == 0) {
            notation.error = true;
            notation.errorCode = 'NO_DICE';
            notation.errorMessage = DICE_ERRORS.NO_DICE;
            if (after_roll) after_roll(notation);
            return;
        }

        // Check if any group has dynamic rules (explode, reroll, etc.)
        var hasDynamic = false;
        for (var gi = 0; gi < notation.groups.length; gi++) {
            var rules = notation.groups[gi].rules || [];
            for (var ri = 0; ri < rules.length; ri++) {
                var type = rules[ri].type;
                if (type === 'explode' || type === 'explode-compounding' || type === 'reroll' || type === 'penetrate') {
                    hasDynamic = true;
                    break;
                }
            }
            if (hasDynamic) break;
        }

        box.rolling = true;
        _setRollWatchdog(box, notation);

        // Handle before_roll callback (only for first phase)
        var request_results = null;
        if (before_roll) {
            try {
                request_results = before_roll(notation);
                if (request_results && request_results.length) {
                }
            } catch (e) {
                var err = createDiceError('CALLBACK_ERROR', 'Error in before_roll callback', e);
                _handleDiceError(box, err, after_roll, notation);
                return; 
            }
        }

        if (hasDynamic) {
            // Use recursive pipeline
            var audit = [];
            var keptAccum = [];
            var maxDepth = vars.max_recursion_depth;
            try{
                // We'll call _process_recursive_roll with the initial notation
                _process_recursive_roll(
                    box,
                    notation,
                    0,          // accumulated total starts at 0
                    0,
                    maxDepth,
                    vector,
                    boost,
                    request_results, // pass forced results for first phase
                    after_roll,
                    audit,
                    keptAccum
                );
            } catch (e) {
                var err = createDiceError('VECTOR_GENERATION_FAILED', null, e);
                _handleDiceError(box, err, after_roll, notation);
                return; 
            }
        } else {
            // Use original simple path (for backward compatibility and performance)
            try {
                var vectors = box.generate_vectors(notation, vector, boost);
                // If forced results, we need to emulate throw and shift faces.
                // _roll_phase handles both cases (with and without forced values).
                box._roll_phase(vectors, request_results || notation.result, function(rawDiceResults) {
                    try {
                        // Now evaluate keep/drop on combined results (no recursion)
                        var combined = combine_compound_results(rawDiceResults, box.dices);
                        
                        // Build audit for simple roll
                        var audit = [];
                        var vals = combined.map(d => d.value).join(', ');
                        logEvent(audit, 0, 'roll', 'Rolled ' + combined.length + ' dice: ' + vals + '.', { dice: combined.map(d => ({id: d.diceId, value: d.value})) });
                        
                        // Apply keep/drop with audit
                        apply_static_rules(notation, combined, audit, 0);
                        apply_dropped_visuals_to_compound(combined, box.dices);
                        apply_result_highlights(box, combined);
                        box.renderer.render(box.scene, box.camera);   

                        // Build final notation
                        var kept = combined.filter(d => d.kept);
                        kept = sortKeptDice(kept, notation);
                        var resultTotal = 0;
                        for (var i = 0; i < kept.length; i++) resultTotal += kept[i].value;
                        resultTotal += notation.constant || 0;
                        var resultString = kept.map(d => d.value).join(' ');
                        if (notation.constant) {
                            if (notation.constant > 0) resultString += ' +' + notation.constant;
                            else resultString += ' -' + Math.abs(notation.constant);
                        }
                        if (kept.length > 1 || notation.constant) {
                            resultString += ' = ' + resultTotal;
                        }
                        notation.result = kept.map(d => d.value);
                        notation.diceResults = combined;
                        notation.resultTotal = resultTotal;
                        notation.resultString = resultString;
                        notation.audit = audit;
                        notation.auditString = that.formatAudit(audit);
                        if (after_roll) after_roll(notation);
                        console.log('Dice Roll: Final result:', notation.resultString, 'Total:', notation.resultTotal, 'Full Result:', notation);
                        box.rolling = false;
                        _clearRollWatchdog(box);
                        vars.use_adaptive_timestep = uat;
                        box._scheduleFade();
                    } catch (e) {
                        var err = createDiceError('UNKNOWN_ERROR', null, e);
                        _handleDiceError(box, err, after_roll, notation);
                        return; 
                    }
                    
                });
            } catch (e) {
                var err = createDiceError('VECTOR_GENERATION_FAILED', null, e);
                _handleDiceError(box, err, after_roll, notation);
                return; 
            }
        }
    }

    // ---------------------------------------------------------------------
    // DICE METHODS
    // ---------------------------------------------------------------------

    /**
     * Generates the initial physical state for every die in a notation.
     *
     * The notation groups are expanded into individual physical dice here.
     * For compound groups (d100), each logical die produces TWO physical vectors.
     *
     * Each vector receives:
     *
     *   id
     *       Unique physical die ID.
     *
     *   groupId
     *       Logical group this die belongs to.
     *
     *   set
     *       Original die type, retained for backwards compatibility.
     *
     *   color
     *       Colour for the die (from preset or group.visual.color).
     *
     *   compoundId (optional)
     *       If present, this die is part of a compound (tens+units).
     *       Same compoundId links the two dice of one logical die.
     *
     *   role (optional)
     *       'tens' or 'units' – only for compound dice.
     *
     * This is the boundary between logical roll notation and physical dice.
     *
     * @param {Object} notation
     * @param {Object} vector
     * @param {number} boost
     * @returns {Object[]}
     */
    that.dice_box.prototype.generate_vectors = function(
        notation,
        vector,
        boost
    ) {

        var self = this;

        var vectors = [];

        var dieId = 0;
        var compoundIdCounter = 0;

        /*
        * Expand every logical group into physical dice.
        */
        for (
            var groupIndex = 0;
            groupIndex < notation.groups.length;
            groupIndex++
        ) {

            var group = notation.groups[groupIndex];

            /*
            * Determine colour for this group.
            * - If group.visual.color is set, use that.
            * - Otherwise pick a preset colour based on group.id (mod 10).
            *   For groups that are clones from an explosion, use the originalGroupId.
            */
            var groupColor;
            var colorId = group.originalGroupId !== undefined ? group.originalGroupId : group.id;
            if (group.visual && group.visual.color !== undefined) {
                groupColor = group.visual.color;
            } else {
                groupColor = vars.preset_colours[colorId % vars.preset_colours.length];
            }

            // Whether this group is compound (e.g., d100 with units)
            var isCompound = group.isCompound && vars.d100_compound;

            for (
                var dieIndex = 0;
                dieIndex < group.count;
                dieIndex++
            ) {

                // For compound groups, we need to generate TWO physical dice per logical die.
                var compoundId = null;
                if (isCompound) {
                    compoundId = compoundIdCounter++;
                }

                // Helper to create a single physical vector
                function createSingleVector(role, dieType) {
                    var vec = make_random_vector(vector);

                    var pos = {
                        x: self.w * (vec.x > 0 ? -1 : 1) * 0.9,   // use self
                        y: self.h * (vec.y > 0 ? -1 : 1) * 0.9,   // use self
                        z: rnd() * 200 + 200
                    };

                    var projector = Math.abs(vec.x / vec.y);
                    if (projector > 1.0) {
                        pos.y /= projector;
                    } else {
                        pos.x *= projector;
                    }

                    var velvec = make_random_vector(vector);
                    var velocity = {
                        x: velvec.x * boost,
                        y: velvec.y * boost,
                        z: -10
                    };

                    var inertia = CONSTS.dice_inertia[dieType];
                    var angle = {
                        x: -(rnd() * vec.y * 5 + inertia * vec.y),
                        y: rnd() * vec.x * 5 + inertia * vec.x,
                        z: 0
                    };

                    var axis = {
                        x: rnd(),
                        y: rnd(),
                        z: rnd(),
                        a: rnd()
                    };

                    var v = {
                        id: dieId++,
                        groupId: group.id,
                        set: dieType,
                        pos: pos,
                        velocity: velocity,
                        angle: angle,
                        axis: axis,
                        color: groupColor
                    };

                    if (isCompound) {
                        v.compoundId = compoundId;
                        v.role = role;
                    }
                    return v;
                }

                if (isCompound) {
                    // Push a tens die (type 'd100') and a units die (type 'd10')
                    vectors.push(createSingleVector('tens', 'd100'));
                    vectors.push(createSingleVector('units', 'd10'));
                } else {
                    // Normal single die
                    vectors.push(createSingleVector(null, group.type));
                }
            }
        }

        return vectors;
    };

    /**
     * Creates a Three.js mesh and Cannon.js rigid body for one physical die.
     *
     * The physical die receives metadata linking it back to the logical
     * notation:
     *
     *     dice.dice_id
     *     dice.group_id
     *     dice.dice_type
     *
     * This allows result evaluation to work without knowing anything about
     * the Three.js scene.
     *
     * @param {string} type
     * @param {Object} pos
     * @param {Object} velocity
     * @param {Object} angle
     * @param {Object} axis
     * @param {number} id
     * @param {number} groupId
     * @param {number} color - Hexadecimal colour for the die body.
     * @param {number} [compoundId] - If provided, this die is part of a compound pair.
     * @param {string} [role] - 'tens' or 'units' if compound.
     */
    that.dice_box.prototype.create_dice = function(
        type,
        pos,
        velocity,
        angle,
        axis,
        id,
        groupId,
        color,
        compoundId,
        role
    ) {

        color = color || 0xf0f0f0; // fallback light grey

        var geometry = threeD_dice.getGeometry(type);
        if (!geometry) {
            console.warn('Dice Roll: Unsupported dice type:', type);
            return;
        }

        var size = vars.scale / 2;
        var margin;
        var face_labels;
        // Material colour set to white so the texture appears un‑tinted
        var materialOptions = $t.copyto(vars.material_options, { color: 0xffffff });
        var bodyColor = color;
        var labelColor = vars.label_color;

        var materials;
        if (type === 'd4') {
            // Use default d4 label variant (index 0)
            materials = create_d4_materials(size, vars.scale * 2, CONSTS.d4_labels[0], materialOptions, bodyColor, labelColor);
        } else {
            switch (type) {
                case 'd6':
                    face_labels = CONSTS.standart_d20_dice_face_labels;
                    margin = 0.9;
                    break;
                case 'd8':
                    face_labels = CONSTS.standart_d20_dice_face_labels;
                    margin = 1.4;
                    break;
                case 'd10':
                case 'd9':
                    face_labels = CONSTS.standart_d20_dice_face_labels;
                    margin = 1.0;
                    break;
                case 'd12':
                    face_labels = CONSTS.standart_d20_dice_face_labels;
                    margin = 1.0;
                    break;
                case 'd20':
                    face_labels = CONSTS.standart_d20_dice_face_labels;
                    margin = 1.2;
                    break;
                case 'd100':
                    face_labels = CONSTS.standart_d100_dice_face_labels;
                    margin = 1.5;
                    break;
                default:
                    face_labels = CONSTS.standart_d20_dice_face_labels;
                    margin = 1.0;
            }
            materials = create_dice_materials(face_labels, size, margin, materialOptions, bodyColor, labelColor);
        }

        var dice = new THREE.Mesh(geometry, new THREE.MeshFaceMaterial(materials));
        dice.castShadow = true;

        /*
         * Physical dice metadata.
         */
        dice.dice_type = type;
        dice.dice_id = id;
        dice.group_id = groupId;

        // Store the body colour so that we can reuse it when shifting faces
        dice.body_color = bodyColor;

        // For d4, store which label variant is currently used (default = 0)
        if (type === 'd4') {
            dice.d4_variant = 0;
        }

        // Store compound info if present
        if (compoundId !== undefined) {
            dice.compoundId = compoundId;
            dice.role = role;
        }

        dice.body =
            new CANNON.RigidBody(
                CONSTS.dice_mass[type],
                dice.geometry.cannon_shape,
                this.dice_body_material
            );

        dice.body.position.set(
            pos.x,
            pos.y,
            pos.z
        );

        dice.body.quaternion.setFromAxisAngle(
            new CANNON.Vec3(
                axis.x,
                axis.y,
                axis.z
            ),
            axis.a * Math.PI * 2
        );

        dice.body.angularVelocity.set(
            angle.x,
            angle.y,
            angle.z
        );

        dice.body.velocity.set(
            velocity.x,
            velocity.y,
            velocity.z
        );

        dice.body.linearDamping = 0.1;
        dice.body.angularDamping = 0.1;

        this.scene.add(dice);
        this.dices.push(dice);
        this.world.add(dice.body);
    };

    /**
     * Determines whether all physical dice have stopped moving.
     *
     * @returns {boolean}
     */
    that.dice_box.prototype.check_if_throw_finished = function() {

        var res = true;
        var e = 6;

        if (
            this.iteration <
            10 / vars.frame_rate
        ) {

            for (
                var i = 0;
                i < this.dices.length;
                ++i
            ) {

                var dice = this.dices[i];

                if (
                    dice.dice_stopped === true
                ) {
                    continue;
                }

                var a = dice.body.angularVelocity;
                var v = dice.body.velocity;

                if (
                    Math.abs(a.x) < e &&
                    Math.abs(a.y) < e &&
                    Math.abs(a.z) < e &&
                    Math.abs(v.x) < e &&
                    Math.abs(v.y) < e &&
                    Math.abs(v.z) < e
                ) {

                    if (dice.dice_stopped) {

                        if (
                            this.iteration -
                            dice.dice_stopped >
                            3
                        ) {

                            dice.dice_stopped = true;
                            continue;
                        }
                    }
                    else {

                        dice.dice_stopped =
                            this.iteration;
                    }

                    res = false;
                }
                else {

                    dice.dice_stopped =
                        undefined;

                    res = false;
                }
            }
        }

        return res;
    };

    /**
     * Runs the physics simulation synchronously until the dice stop.
     *
     * This is primarily used when an authoritative result has been supplied
     * and the library needs to determine the current physical face before
     * shifting the visible faces to the requested values.
     *
     * @returns {Object[]}
     *        Rich physical dice result objects (raw, per physical die).
     */
    that.dice_box.prototype.emulate_throw = function() {

        while (
            !this.check_if_throw_finished()
        ) {

            ++this.iteration;

            this.world.step(
                vars.frame_rate
            );
        }

        return get_dice_values(
            this.dices
        );
    };

    /**
     * Animates the physics simulation.
     *
     * @param {number} threadid
     */
    that.dice_box.prototype.__animate = function(threadid) {

        var time = (new Date()).getTime();

        var time_diff =
            (time - this.last_time) /
            1000;

        if (time_diff > 3) {
            time_diff = vars.frame_rate;
        }

        ++this.iteration;

        if (vars.use_adaptive_timestep) {

            while (
                time_diff >
                vars.frame_rate * 1.1
            ) {

                this.world.step(
                    vars.frame_rate
                );

                time_diff -=
                    vars.frame_rate;
            }

            this.world.step(
                time_diff
            );
        }
        else {

            this.world.step(
                vars.frame_rate
            );
        }

        /*
         * Synchronise Three.js meshes with their Cannon.js bodies.
         */
        for (
            var i in this.scene.children
        ) {

            var interact =
                this.scene.children[i];

            if (
                interact.body != undefined
            ) {

                interact.position.copy(
                    interact.body.position
                );

                interact.quaternion.copy(
                    interact.body.quaternion
                );
            }
        }

        this.renderer.render(
            this.scene,
            this.camera
        );

        this.last_time =
            this.last_time
                ? time
                : (new Date()).getTime();

        if (
            this.running == threadid &&
            this.check_if_throw_finished()
        ) {

            this.running = false;

            if (this.callback) {

                this.callback.call(
                    this,
                    get_dice_values(
                        this.dices
                    )
                );
            }
        }

        if (
            this.running == threadid
        ) {

            (function(
                t,
                tid,
                uat
            ) {

                if (
                    !uat &&
                    time_diff < vars.frame_rate
                ) {

                    setTimeout(
                        function() {

                            requestAnimationFrame(
                                function() {
                                    t.__animate(tid);
                                }
                            );
                        },

                        (
                            vars.frame_rate -
                            time_diff
                        ) * 1000
                    );
                }
                else {

                    requestAnimationFrame(
                        function() {
                            t.__animate(tid);
                        }
                    );
                }

            })(
                this,
                threadid,
                vars.use_adaptive_timestep
            );
        }
    };

    /**
     * Removes all current physical dice from the scene and physics world.
     */
    that.dice_box.prototype.clear = function() {

        if (this._fadeTimeout) {
            clearTimeout(this._fadeTimeout);
            this._fadeTimeout = null;
        }
        if (this._fadeRafId) {
            cancelAnimationFrame(this._fadeRafId);
            this._fadeRafId = null;
        }

        this.running = false;

        var dice;

        while (
            dice = this.dices.pop()
        ) {

            this.scene.remove(dice);

            if (dice.body) {
                this.world.remove(
                    dice.body
                );
            }
        }

        if (this.pane) {
            this.scene.remove(
                this.pane
            );
        }

        this.renderer.render(
            this.scene,
            this.camera
        );

        var box = this;

        setTimeout(
            function() {

                box.renderer.render(
                    box.scene,
                    box.camera
                );

            },
            100
        );
    };

    /**
     * Destroys the dice box, removing all dice and cleaning up resources.
     * After calling this, the instance is unusable — discard your reference.
     */
    that.dice_box.prototype.destroy = function() {
        _clearRollWatchdog(this);
        this.clear();
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this._fadeTimeout) clearTimeout(this._fadeTimeout);
        if (this._fadeRafId) cancelAnimationFrame(this._fadeRafId);
        this.renderer.dispose();
        if (this.renderer.domElement.parentNode) {
            this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
        }
        this.dices = [];
        this.scene = null;
        this.world = null;
    };

    /**
     * Schedules a fade-out of all current dice, then clears them.
     *
     * Cancels any fade already in progress. Called automatically at the end
     * of a roll, but safe to call manually.
     */
    that.dice_box.prototype._scheduleFade = function() {
        var box = this;

        if (box._fadeTimeout) {
            clearTimeout(box._fadeTimeout);
            box._fadeTimeout = null;
        }
        if (box._fadeRafId) {
            cancelAnimationFrame(box._fadeRafId);
            box._fadeRafId = null;
        }

        if (!vars.fade_enabled) return;

        var delay = Math.max(0, vars.fade_delay_ms || 0);
        if (delay === 0) {
            box._startFade();
        } else {
            box._fadeTimeout = setTimeout(function() {
                box._fadeTimeout = null;
                box._startFade();
            }, delay);
        }
    };

    /**
     * Begins the fade animation. When opacity reaches zero, clears all dice.
     */
    that.dice_box.prototype._startFade = function() {
        var box = this;
        var duration = Math.max(0, vars.fade_duration_ms || 0);

        if (!box.dices.length) return;

        if (duration === 0) {
            box.clear();
            return;
        }

        // Kill shadows so they don't linger after the bodies vanish.
        for (var s = 0; s < box.dices.length; s++) {
            box.dices[s].castShadow = false;
        }

        var startTime = null;
        var rafId = null;

        function step(now) {
            if (box._fadeRafId !== rafId) return;

            if (startTime === null) startTime = now;
            var t = (now - startTime) / duration;
            if (t > 1) t = 1;

            var opacity = 1 - t;
            for (var i = 0; i < box.dices.length; i++) {
                var mats = get_die_materials(box.dices[i]);
                for (var m = 0; m < mats.length; m++) {
                    mats[m].opacity = opacity;
                }
            }

            box.renderer.render(box.scene, box.camera);

            if (t < 1) {
                rafId = requestAnimationFrame(step);
                box._fadeRafId = rafId;
            } else {
                box._fadeRafId = null;
                box.clear();
            }
        }

        rafId = requestAnimationFrame(step);
        box._fadeRafId = rafId;
    };

    /**
     * Creates the physical dice represented by the supplied vectors.
     *
     * @param {Object[]} vectors
     */
    that.dice_box.prototype.prepare_dices_for_roll = function(
        vectors
    ) {

        this.clear();

        this.iteration = 0;

        for (
            var i = 0;
            i < vectors.length;
            i++
        ) {

            var vector =
                vectors[i];

            this.create_dice(
                vector.set,
                vector.pos,
                vector.velocity,
                vector.angle,
                vector.axis,
                vector.id,
                vector.groupId,
                vector.color,
                vector.compoundId,   // may be undefined
                vector.role          // may be undefined
            );
        }
    };

    /**
     * Rolls a set of physical dice.
     *
     * If values are supplied, the dice are first physically simulated so the
     * current face can be determined, then their visible face labels are
     * shifted to the requested values.
     *
     * @param {Object[]} vectors
     * @param {number[]} values
     * @param {Function} callback
     */
    that.dice_box.prototype._roll_phase = function(
        vectors,
        values,
        callback
    ) {
        var box = this;

        this.prepare_dices_for_roll(
            vectors
        );

        if (
            values != undefined &&
            values.length
        ) {

            /*
             * Forced results are a visualisation feature. The simulation is
             * temporarily made deterministic here so we can establish the
             * current face of each die before applying the desired value.
             */
            vars.use_adaptive_timestep = false;

            var res =
                this.emulate_throw();

            /*
             * Recreate the original throw state before the visible faces are
             * shifted. This keeps the animation starting point consistent.
             */
            this.prepare_dices_for_roll(
                vectors
            );

            // For compound dice, we need to split the forced value into tens and units.
            // Build a map of physical die ID to its compoundId and role.
            var diceMap = {};
            for (var i = 0; i < vectors.length; i++) {
                var vec = vectors[i];
                if (vec.compoundId !== undefined) {
                    diceMap[vec.id] = { compoundId: vec.compoundId, role: vec.role };
                }
            }

            // For each physical die, determine the requested value.
            // We have 'res' (raw face values) and 'values' (forced results per logical die).
            // We need to apply the shift to each physical die based on its role.
            // The order of physical dice in 'this.dices' matches the order of vectors.
            // However, we have the vectors list, which we can use to correlate.

            // We'll create an array of requested values per physical die.
            var requestedValuesPerDie = [];
            var logicalDieIndex = 0;
            for (var i = 0; i < vectors.length; i++) {
                var vec = vectors[i];
                if (vec.compoundId !== undefined) {
                    // This physical die is part of a compound.
                    // The logical die index corresponds to this compound.
                    var fullValue = values[logicalDieIndex];
                    var tens = Math.floor(fullValue / 10) % 10;
                    var unit = fullValue % 10;
                    if (vec.role === 'tens') {
                        requestedValuesPerDie.push(tens);
                    } else { // units
                        requestedValuesPerDie.push(unit);
                        // Store the forced unit on the mesh so combine_compound_results can use it later.
                        // Find the mesh for this physical die.
                        var mesh = null;
                        for (var j = 0; j < box.dices.length; j++) {
                            if (box.dices[j].dice_id === vec.id) {
                                mesh = box.dices[j];
                                break;
                            }
                        }
                        if (mesh) {
                            mesh.forced_unit = unit;
                        }
                    }
                    // Only increment logicalDieIndex when we've processed both dice of this compound.
                    // Since vectors are ordered such that tens comes before units for each compound,
                    // we increment after processing the units die.
                    if (vec.role === 'units') {
                        logicalDieIndex++;
                    }
                } else {
                    // Normal single die
                    requestedValuesPerDie.push(values[logicalDieIndex]);
                    logicalDieIndex++;
                }
            }

            // Now apply the shifts.
            for (
                var i = 0;
                i < res.length;
                i++
            ) {

                shift_dice_faces(
                    this.dices[i],
                    requestedValuesPerDie[i],
                    res[i].value
                );
            }
        }

        this.callback = callback;

        this.running =
            (new Date()).getTime();

        this.last_time = 0;

        this.__animate(
            this.running
        );
    };

    /**
     * Searches for a rendered die under the mouse position.
     *
     * The existing API is retained for compatibility with consumers which
     * use the dice mesh's userData.
     *
     * @param {Event} ev
     * @returns {Object|undefined}
     */
    that.dice_box.prototype.search_dice_by_mouse = function(ev) {

        var m =
            $t.get_mouse_coords(ev);

        var intersects =
            new THREE.Raycaster(
                this.camera.position,

                (
                    new THREE.Vector3(
                        (m.x - this.cw) /
                            this.aspect,

                        1 -
                            (m.y - this.ch) /
                            this.aspect,

                        this.w / 9
                    )
                )
                .sub(this.camera.position)
                .normalize()
            )
            .intersectObjects(
                this.dices
            );

        if (intersects.length) {
            return intersects[0]
                .object
                .userData;
        }
    };

    /**
     * Returns metadata for a given parameter, including its current value.
     * @param {string} name - Parameter name.
     * @returns {Object} { type, min, max, default, description, current }
     */
    that.dice_box.prototype.getParamInfo = function getParamInfo(name) {
        const def = CONFIG_DEFS[name];
        if (!def) throw new Error(`Unknown parameter "${name}"`);
        const current = getConfigValue(name, this);
        return { ...def, current };
    };

    /**
     * Returns the current value of a parameter.
     * @param {string} name - Parameter name.
     * @returns {*} Current value.
     */
    that.dice_box.prototype.getParam = function getParam(name) {
        const info = this.getParamInfo(name);
        return info.current;
    };

    /**
     * Sets a parameter to a new value and applies it.
     * @param {string} name - Parameter name.
     * @param {*} value - New value (will be validated and coerced).
     * @returns {this} For chaining.
     */
    that.dice_box.prototype.setParam = function setParam(name, value) {
        const def = CONFIG_DEFS[name];
        if (!def) throw new Error(`Unknown parameter "${name}"`);

        if (def.nullable && (value === null || value === undefined)) {
            this._applyParam(name, null);
            return this;
        }
        // Validate type and range
        let parsed;
        if (def.type === 'boolean') {
            parsed = !!value;
        } else if (def.type === 'integer') {
            parsed = Math.round(Number(value));
            if (!Number.isFinite(parsed)) throw new Error(`Expected an integer, got "${value}"`);
            if (parsed < def.min || parsed > def.max) {
                throw new Error(`Value must be between ${def.min} and ${def.max}`);
            }
        } else if (def.type === 'number') {
            parsed = Number(value);
            if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got "${value}"`);
            if (parsed < def.min || parsed > def.max) {
                throw new Error(`Value must be between ${def.min} and ${def.max}`);
            }
        } else if (def.type === 'color') {
            // Accept both hex strings and numbers
            if (typeof value === 'string' && value.startsWith('#')) {
                parsed = value;
            } else if (typeof value === 'number') {
                parsed = `#${value.toString(16).padStart(6, '0')}`;
            } else {
                throw new Error(`Expected a color string (#RRGGBB) or number`);
            }
        } else {
            throw new Error(`Unsupported type "${def.type}" for "${name}"`);
        }

        // Apply the value to the appropriate storage
        this._applyParam(name, parsed);

        return this;
    };

    /**
     * Applies a single parameter change (internal).
     * @param {string} name - Parameter name.
     * @param {*} value - Validated value.
     */
    that.dice_box.prototype._applyParam = function _applyParam(name, value) {
        const instance = this;

        switch (name) {
            case 'gravity_x':
            case 'gravity_y':
            case 'gravity_z':
                instance.world.gravity[name === 'gravity_x' ? 'x' : name === 'gravity_y' ? 'y' : 'z'] = value;
                break;
            case 'solver_iterations':
                instance.world.solver.iterations = value;
                break;
            case 'dice_friction':
            case 'dice_restitution':
            case 'dice_dice_friction':
            case 'dice_dice_restitution':
                instance._updateContactMaterials();
                break;
            case 'linear_damping':
            case 'angular_damping':
                vars.linear_damping = value;
                vars.angular_damping = value;
                // Apply to existing dice
                for (let i = 0; i < instance.dices.length; i++) {
                    const body = instance.dices[i].body;
                    if (body) {
                        body.linearDamping = value;
                        body.angularDamping = value;
                    }
                }
                break;
            case 'use_adaptive_timestep':
                vars.use_adaptive_timestep = value;
                break;
            case 'frame_rate':
                vars.frame_rate = Math.max(0.001, Math.min(0.1, value));
                break;
            case 'camera_distance':
                if (instance.camera) {
                    instance.camera.position.z = value;
                    instance.camera.lookAt(0, 0, 0);
                }
                break;
            case 'camera_fov':
                if (instance.camera) {
                    instance.camera.fov = value;
                    instance.camera.updateProjectionMatrix();
                }
                break;
            case 'ambient_light_color':
                vars.ambient_light_color = colorToNumber(value);
                instance._updateLighting();
                break;
            case 'spot_light_color':
                vars.spot_light_color = colorToNumber(value);
                instance._updateLighting();
                break;
            case 'spot_light_intensity':
                vars.spot_light_intensity = value;
                if (instance.light) {
                    instance.light.intensity = value;
                }
                break;
            case 'desk_color':
                vars.desk_color = value;
                if (instance.desk) {
                    instance.desk.material.color.set(value);
                }
                break;
            case 'desk_opacity':
                vars.desk_opacity = value;
                if (instance.desk) {
                    instance.desk.material.opacity = value;
                    instance.desk.material.transparent = value < 1;
                    instance.desk.material.needsUpdate = true;
                }
                break;
            case 'use_shadows':
                vars.use_shadows = value;
                instance.renderer.shadowMap.enabled = value;
                if (instance.desk) instance.desk.receiveShadow = value;
                for (let i = 0; i < instance.dices.length; i++) {
                    instance.dices[i].castShadow = value;
                }
                break;
            case 'dice_color':
                vars.dice_color = colorToNumber(value);
                break;
            case 'label_color':
                vars.label_color = value;
                break;
            case 'dropped_dice_color':
                vars.dropped_dice_color = value;
                break;
            case 'dropped_dice_label_color':
                vars.dropped_dice_label_color = value;
                break;
            case 'd100_compound':
                vars.d100_compound = value;
                break;
            case 'max_recursion_depth':
                vars.max_recursion_depth = value;
                break;
            case 'max_dice_per_roll':
                vars.max_dice_per_roll = value;
                break;
            case 'size_multiplier':
                vars.size_multiplier = value;
                applyScaleForCount(instance, instance._lastDiceCount || 0);
                break;
            case 'auto_scale_enabled':
                vars.auto_scale_enabled = value;
                break;

            case 'auto_scale_baseline_dice':
                vars.auto_scale_baseline_dice = value;
                break;

            case 'auto_scale_exponent':
                vars.auto_scale_exponent = value;
                break;

            case 'auto_scale_min_factor':
                vars.auto_scale_min_factor = value;
                break;

            case 'fade_enabled':
                vars.fade_enabled = value;
                break;

            case 'fade_delay_ms':
                vars.fade_delay_ms = value;
                break;

            case 'fade_duration_ms':
                vars.fade_duration_ms = value;
                break;
            
            case 'roll_timeout_ms':
                vars.roll_timeout_ms = value;
                break;

            case 'rng_seed':
                setRngSeed(value);
                break;

            default:
                throw new Error(`Unhandled parameter "${name}"`);
        }
    };

    /**
     * Returns a full copy of the current configuration.
     * @returns {Object} Mapping of parameter names to values.
     */
    that.dice_box.prototype.getConfig = function getConfig() {
        const result = {};
        for (const name of Object.keys(CONFIG_DEFS)) {
            result[name] = this.getParam(name);
        }
        return result;
    };

    /**
     * Applies a batch of configuration changes.
     * @param {Object} config - Mapping of parameter names to values.
     * @returns {this}
     */
    that.dice_box.prototype.setConfig = function setConfig(config) {
        for (const [name, value] of Object.entries(config)) {
            this.setParam(name, value);
        }
        return this;
    };

    /**
     * Rolls one of each die type for a preview.
     * @param {Function} callback - Called with the notation result object.
     */
    that.dice_box.prototype.previewRoll = function previewRoll(callback) {
        const notation = '1d4+1d6+1d8+1d10+1d12+1d20+1d100';
        this.setDice(notation);
        const promise = this.start_throw();
        if (callback) promise.then(callback, callback);
        return promise;
    };


    // Helper to convert CSS color to number (if needed)
    function colorToNumber(color) {
        if (typeof color === 'number') return color;
        if (typeof color === 'string' && color.startsWith('#')) {
            return parseInt(color.slice(1), 16);
        }
        return 0x808080;
    }

    // Helper to update contact materials (friction/restitution)
    that.dice_box.prototype._updateContactMaterials = function _updateContactMaterials() {
        // Rebuild the contact materials with current friction/restitution values
        const deskFriction = vars.dice_friction || 0.01;
        const deskRest = vars.dice_restitution || 0.5;
        const diceFriction = vars.dice_dice_friction || 0;
        const diceRest = vars.dice_dice_restitution || 0.5;

        if (this._deskDiceContact) {
            this._deskDiceContact.friction = deskFriction;
            this._deskDiceContact.restitution = deskRest;
        }
        if (this._diceDiceContact) {
            this._diceDiceContact.friction = diceFriction;
            this._diceDiceContact.restitution = diceRest;
        }
    };

    // Helper to update lighting
    that.dice_box.prototype._updateLighting = function _updateLighting() {
        for (let i = 0; i < this.scene.children.length; i++) {
            const child = this.scene.children[i];
            if (child instanceof THREE.AmbientLight) {
                child.color.setHex(vars.ambient_light_color);
            }
        }
        if (this.light) {
            this.light.color.setHex(vars.spot_light_color);
        }
    };

    // ---------------------------------------------------------------------
    // PRIVATE DICE RESULT ENGINE (NEW)
    // ---------------------------------------------------------------------

    /**
     * Combines raw physical dice results into logical compound results.
     *
     * For compound dice (d100), this pairs up the tens and units dice
     * by their compoundId and computes the combined value (tens*10+unit).
     * Non‑compound dice are passed through unchanged.
     *
     * The returned array contains one entry per logical die, each with:
     *   - diceId: the ID of the tens die (or the single die for non‑compound)
     *   - groupId
     *   - type: the group type (e.g., 'd100')
     *   - value: the combined numeric result
     *   - kept: true (to be modified later)
     *   - subResults: array of the raw physical dice that make up this die
     *                 (for compound, two entries; for normal, one)
     *
     * @param {Object[]} rawResults - Array of per‑physical‑die results (from get_dice_values)
     * @param {THREE.Mesh[]} dices - Array of Three.js meshes (for forced unit storage)
     * @returns {Object[]} Combined results per logical die.
     */
    function combine_compound_results(rawResults, dices) {
        // Build a map from physical dice ID to the mesh (to read forced_unit if any)
        var diceMeshMap = {};
        for (var i = 0; i < dices.length; i++) {
            diceMeshMap[dices[i].dice_id] = dices[i];
        }

        // Separate compound and non‑compound results.
        var compounds = {};
        var nonCompound = [];

        for (var i = 0; i < rawResults.length; i++) {
            var r = rawResults[i];
            var mesh = diceMeshMap[r.diceId];
            if (mesh && mesh.compoundId !== undefined) {
                var cid = mesh.compoundId;
                if (!compounds[cid]) {
                    compounds[cid] = {};
                }
                compounds[cid][mesh.role] = r;
                compounds[cid]._mesh = mesh;
            } else {
                nonCompound.push(r);
            }
        }

        var combined = [];

        // Process compounds
        for (var cid in compounds) {
            var comp = compounds[cid];
            var tensResult = comp.tens;
            var unitResult = comp.units;
            if (!tensResult || !unitResult) {
                console.warn('Dice Roll: Incomplete compound', cid);
                continue;
            }

            // tensResult.value is the tens digit * 10 (e.g., 60 for face "60")
            var tensDigit = tensResult.value / 10; // get 0-9
            var unitDigit = unitResult.value;      // 0-9
            // If forced unit is present, use it
            var mesh = comp._mesh;
            if (mesh && mesh.forced_unit !== undefined) {
                unitDigit = mesh.forced_unit;
                delete mesh.forced_unit;
            }
            var combinedValue = (tensDigit * 10) + unitDigit;
            if (combinedValue === 0) {
                combinedValue = 100;
            }

            combined.push({
                diceId: tensResult.diceId,
                groupId: tensResult.groupId,
                type: tensResult.type,
                value: combinedValue,
                kept: true,
                subResults: [tensResult, unitResult]
            });
        }

        // Process non‑compound
        for (var i = 0; i < nonCompound.length; i++) {
            var r = nonCompound[i];
            combined.push({
                diceId: r.diceId,
                groupId: r.groupId,
                type: r.type,
                value: r.value,
                kept: true,
                subResults: [r]
            });
        }

        return combined;
    }

    /**
     * Applies dropped visuals to both physical dice of a dropped compound.
     *
     * For each combined result that has kept=false, we look at its subResults
     * and grey out all the physical dice.
     *
     * @param {Object[]} combinedResults - Array of combined logical dice results (with kept flags).
     * @param {THREE.Mesh[]} dices - Array of all physical dice meshes.
     */
    function apply_dropped_visuals_to_compound(combinedResults, dices) {
        // Build a map from physical die ID to mesh
        var diceMap = {};
        for (var i = 0; i < dices.length; i++) {
            diceMap[dices[i].dice_id] = dices[i];
        }

        var droppedCount = 0;
        for (var i = 0; i < combinedResults.length; i++) {
            var combined = combinedResults[i];
            if (!combined.kept) {
                // This logical die is dropped – grey out all its physical dice
                var subResults = combined.subResults || [];
                for (var j = 0; j < subResults.length; j++) {
                    var sr = subResults[j];
                    var dice = diceMap[sr.diceId];
                    if (!dice) continue;
                    // Apply the grey material
                    var type = dice.dice_type;
                    var size = vars.scale / 2;
                    var margin;
                    var face_labels;
                    var materialOptions = $t.copyto(vars.material_options, { color: 0xffffff });
                    var bodyColor = vars.dropped_dice_color;
                    var labelColor = vars.dropped_dice_label_color;

                    var materials;
                    if (type === 'd4') {
                        var variant = (dice.d4_variant !== undefined) ? dice.d4_variant : 0;
                        materials = create_d4_materials(size, vars.scale * 2, CONSTS.d4_labels[variant], materialOptions, bodyColor, labelColor);
                    } else {
                        switch (type) {
                            case 'd6':  face_labels = CONSTS.standart_d20_dice_face_labels; margin = 0.9; break;
                            case 'd8':  face_labels = CONSTS.standart_d20_dice_face_labels; margin = 1.4; break;
                            case 'd10': case 'd9': face_labels = CONSTS.standart_d20_dice_face_labels; margin = 1.0; break;
                            case 'd12': face_labels = CONSTS.standart_d20_dice_face_labels; margin = 1.0; break;
                            case 'd20': face_labels = CONSTS.standart_d20_dice_face_labels; margin = 1.2; break;
                            case 'd100': face_labels = CONSTS.standart_d100_dice_face_labels; margin = 1.5; break;
                            default: face_labels = CONSTS.standart_d20_dice_face_labels; margin = 1.0;
                        }
                        materials = create_dice_materials(face_labels, size, margin, materialOptions, bodyColor, labelColor);
                    }
                    dice.material = new THREE.MeshFaceMaterial(materials);
                    dice.dropped_visuals_applied = true;
                    droppedCount++;
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // EXPLOSION VISUAL EFFECTS
    // ---------------------------------------------------------------------

    /**
     * Applies a subtle emissive glow to a physical die that exploded.
     * @param {THREE.Mesh} mesh - The die mesh.
     */
    function apply_explosion_highlight(mesh) {
        if (!mesh || !mesh.material) return;
        if (mesh._exploded) return; // already highlighted

        // Get the materials array (for MeshFaceMaterial, it's under .materials)
        var materials = Array.isArray(mesh.material) ? mesh.material : 
                        (mesh.material.materials ? mesh.material.materials : [mesh.material]);

        for (var i = 0; i < materials.length; i++) {
            var mat = materials[i];
            if (!mat) continue;
            // Do NOT change the base colour – keep the original texture.
            // Instead, add a warm emissive glow.
            mat.emissive = new THREE.Color(0xff8800); // orange-gold
            mat.emissiveIntensity = 0.1;              // subtle glow
            // Slightly increase shininess for a more “excited” look
            mat.shininess = 40;
        }
        mesh._exploded = true;
    }

    function apply_critical_highlight(mesh, isFailure) {
        if (!mesh || !mesh.material) return;
        if (mesh._criticalHighlighted) return;

        var materials = Array.isArray(mesh.material) ? mesh.material :
                        (mesh.material.materials ? mesh.material.materials : [mesh.material]);
        var color = isFailure ? 0x990000 : 0x006622;

        for (var i = 0; i < materials.length; i++) {
            var mat = materials[i];
            if (!mat) continue;
            mat.emissive = new THREE.Color(color);
            mat.emissiveIntensity = 0.18;
        }
        mesh._criticalHighlighted = true;
    }

    function apply_result_highlights(box, combined) {
        for (var i = 0; i < combined.length; i++) {
            var die = combined[i];
            if (!die.critical && !die.failure) continue;
            var isFailure = die.failure === true;
            var subs = die.subResults || [die];
            for (var j = 0; j < subs.length; j++) {
                var mesh = box.dices.find(function(d) { return d.dice_id === subs[j].diceId; });
                if (mesh) apply_critical_highlight(mesh, isFailure);
            }
        }
    }

    /**
     * Calculates the final numeric result.
     *
     * Only dice marked as kept contribute to the total.
     *
     * @param {Object[]} diceResults
     * @param {number} constant
     * @returns {number}
     */
    function calculate_result(
        diceResults,
        constant
    ) {

        var total =
            constant || 0;

        for (
            var i = 0;
            i < diceResults.length;
            i++
        ) {

            if (
                diceResults[i].kept
            ) {

                total +=
                    diceResults[i].value;
            }
        }

        return total;
    }

    // ---------------------------------------------------------------------
    // DICE GEOMETRIES / MATERIALS
    // ---------------------------------------------------------------------

    /**
     * Cache of generated dice geometry/materials.
     */
    let threeD_dice = {};

    /**
     * Returns the geometry for a given dice type, creating it if needed.
     *
     * @param {string} type - e.g., 'd6', 'd20', etc.
     * @returns {THREE.Geometry|null}
     */
    threeD_dice.getGeometry = function(type) {
        switch (type) {
            case 'd4':
                if (!this.d4_geometry) {
                    this.d4_geometry = create_d4_geometry(vars.scale * 1.2);
                }
                return this.d4_geometry;
            case 'd6':
                if (!this.d6_geometry) {
                    this.d6_geometry = create_d6_geometry(vars.scale * 1.1);
                }
                return this.d6_geometry;
            case 'd8':
                if (!this.d8_geometry) {
                    this.d8_geometry = create_d8_geometry(vars.scale);
                }
                return this.d8_geometry;
            case 'd9':
            case 'd10':
                if (!this.d10_geometry) {
                    this.d10_geometry = create_d10_geometry(vars.scale * 0.9);
                }
                return this.d10_geometry;
            case 'd12':
                if (!this.d12_geometry) {
                    this.d12_geometry = create_d12_geometry(vars.scale * 0.9);
                }
                return this.d12_geometry;
            case 'd20':
                if (!this.d20_geometry) {
                    this.d20_geometry = create_d20_geometry(vars.scale);
                }
                return this.d20_geometry;
            case 'd100':
                if (!this.d10_geometry) {
                    this.d10_geometry = create_d10_geometry(vars.scale * 0.9);
                }
                return this.d10_geometry;
            default:
                return null;
        }
    };

    /**
     * Creates a d4 mesh (kept for backward compatibility).
     *
     * @returns {THREE.Mesh}
     */
    threeD_dice.create_d4 = function() {

        if (!this.d4_geometry) {
            this.d4_geometry =
                create_d4_geometry(
                    vars.scale * 1.2
                );
        }

        if (!this.d4_material) {

            this.d4_material =
                new THREE.MeshFaceMaterial(
                    create_d4_materials(
                        vars.scale / 2,
                        vars.scale * 2,
                        CONSTS.d4_labels[0]
                    )
                );
        }

        return new THREE.Mesh(
            this.d4_geometry,
            this.d4_material
        );
    };

    /**
     * Creates a d6 mesh (kept for backward compatibility).
     *
     * @returns {THREE.Mesh}
     */
    threeD_dice.create_d6 = function() {

        if (!this.d6_geometry) {

            this.d6_geometry =
                create_d6_geometry(
                    vars.scale * 1.1
                );
        }

        if (!this.dice_material) {

            this.dice_material =
                new THREE.MeshFaceMaterial(
                    create_dice_materials(
                        CONSTS.standart_d20_dice_face_labels,
                        vars.scale / 2,
                        0.9
                    )
                );
        }

        return new THREE.Mesh(
            this.d6_geometry,
            this.dice_material
        );
    };

    /**
     * Creates a d8 mesh (kept for backward compatibility).
     *
     * @returns {THREE.Mesh}
     */
    threeD_dice.create_d8 = function() {

        if (!this.d8_geometry) {

            this.d8_geometry =
                create_d8_geometry(
                    vars.scale
                );
        }

        if (!this.dice_material) {

            this.dice_material =
                new THREE.MeshFaceMaterial(
                    create_dice_materials(
                        CONSTS.standart_d20_dice_face_labels,
                        vars.scale / 2,
                        1.4
                    )
                );
        }

        return new THREE.Mesh(
            this.d8_geometry,
            this.dice_material
        );
    };

    /**
     * Creates a d9 mesh (kept for backward compatibility).
     *
     * @returns {THREE.Mesh}
     */
    threeD_dice.create_d9 = function() {

        if (!this.d10_geometry) {

            this.d10_geometry =
                create_d10_geometry(
                    vars.scale * 0.9
                );
        }

        if (!this.dice_material) {

            this.dice_material =
                new THREE.MeshFaceMaterial(
                    create_dice_materials(
                        CONSTS.standart_d20_dice_face_labels,
                        vars.scale / 2,
                        1.0
                    )
                );
        }

        return new THREE.Mesh(
            this.d10_geometry,
            this.dice_material
        );
    };

    /**
     * Creates a d10 mesh (kept for backward compatibility).
     *
     * @returns {THREE.Mesh}
     */
    threeD_dice.create_d10 = function() {

        if (!this.d10_geometry) {

            this.d10_geometry =
                create_d10_geometry(
                    vars.scale * 0.9
                );
        }

        if (!this.dice_material) {

            this.dice_material =
                new THREE.MeshFaceMaterial(
                    create_dice_materials(
                        CONSTS.standart_d20_dice_face_labels,
                        vars.scale / 2,
                        1.0
                    )
                );
        }

        return new THREE.Mesh(
            this.d10_geometry,
            this.dice_material
        );
    };

    /**
     * Creates a d12 mesh (kept for backward compatibility).
     *
     * @returns {THREE.Mesh}
     */
    threeD_dice.create_d12 = function() {

        if (!this.d12_geometry) {

            this.d12_geometry =
                create_d12_geometry(
                    vars.scale * 0.9
                );
        }

        if (!this.dice_material) {

            this.dice_material =
                new THREE.MeshFaceMaterial(
                    create_dice_materials(
                        CONSTS.standart_d20_dice_face_labels,
                        vars.scale / 2,
                        1.0
                    )
                );
        }

        return new THREE.Mesh(
            this.d12_geometry,
            this.dice_material
        );
    };

    /**
     * Creates a d20 mesh (kept for backward compatibility).
     *
     * @returns {THREE.Mesh}
     */
    threeD_dice.create_d20 = function() {

        if (!this.d20_geometry) {

            this.d20_geometry =
                create_d20_geometry(
                    vars.scale
                );
        }

        if (!this.dice_material) {

            this.dice_material =
                new THREE.MeshFaceMaterial(
                    create_dice_materials(
                        CONSTS.standart_d20_dice_face_labels,
                        vars.scale / 2,
                        1.2
                    )
                );
        }

        return new THREE.Mesh(
            this.d20_geometry,
            this.dice_material
        );
    };

    /**
     * Creates a d100 mesh (kept for backward compatibility).
     *
     * @returns {THREE.Mesh}
     */
    threeD_dice.create_d100 = function() {

        if (!this.d10_geometry) {

            this.d10_geometry =
                create_d10_geometry(
                    vars.scale * 0.9
                );
        }

        if (!this.d100_material) {

            this.d100_material =
                new THREE.MeshFaceMaterial(
                    create_dice_materials(
                        CONSTS.standart_d100_dice_face_labels,
                        vars.scale / 2,
                        1.5
                    )
                );
        }

        return new THREE.Mesh(
            this.d10_geometry,
            this.d100_material
        );
    };

    /**
     * Creates standard dice face materials.
     *
     * @param {string[]} face_labels
     * @param {number} size
     * @param {number} margin
     * @param {Object} [materialOptions] - Optional override for material properties (e.g., color).
     * @param {number|string} [bodyColor] - Colour used as the background of the face texture.
     * @param {string} [labelColor] - Colour of the label text.
     * @returns {THREE.Material[]}
     */
    function create_dice_materials(
        face_labels,
        size,
        margin,
        materialOptions,
        bodyColor,
        labelColor
    ) {
        materialOptions = materialOptions || vars.material_options;
        bodyColor = bodyColor || vars.dice_color;
        labelColor = labelColor || vars.label_color;

        /**
         * Creates a text texture for one die face.
         *
         * @param {string} text
         * @param {string|number} color
         * @param {string|number} back_color
         * @returns {THREE.Texture|null}
         */
        function create_text_texture(
            text,
            color,
            back_color
        ) {

            if (text == undefined) {
                return null;
            }

            var canvas =
                document.createElement(
                    "canvas"
                );

            var context =
                canvas.getContext("2d");

            var ts =
                calc_texture_size(
                    size +
                    size * 2 * margin
                ) * 2;

            canvas.width =
                canvas.height =
                    ts;

            context.font =
                ts /
                (1 + 2 * margin) +
                "pt Arial";

            context.fillStyle =
                back_color;

            context.fillRect(
                0,
                0,
                canvas.width,
                canvas.height
            );

            context.textAlign =
                "center";

            context.textBaseline =
                "middle";

            context.fillStyle =
                color;

            context.fillText(
                text,
                canvas.width / 2,
                canvas.height / 2
            );

            /*
             * Add the conventional dot under 6/9 to make the distinction
             * visually obvious.
             */
            if (
                text == '6' ||
                text == '9'
            ) {

                context.fillText(
                    '  .',
                    canvas.width / 2,
                    canvas.height / 2
                );
            }

            var texture =
                new THREE.Texture(
                    canvas
                );

            texture.needsUpdate =
                true;

            return texture;
        }

        var materials = [];
        var bg = colorToCSS(bodyColor);

        for (
            var i = 0;
            i < face_labels.length;
            ++i
        ) {

            materials.push(
                new THREE.MeshPhongMaterial(
                    $t.copyto(
                        materialOptions,
                        {
                            transparent: true,
                            map:
                                create_text_texture(
                                    face_labels[i],
                                    labelColor,
                                    bg
                                )
                        }
                    )
                )
            );
        }

        return materials;
    }

    /**
     * Creates d4-specific face materials.
     *
     * @param {number} size
     * @param {number} margin
     * @param {Array[]} labels
     * @param {Object} [materialOptions] - Optional override for material properties.
     * @param {number|string} [bodyColor] - Colour used as the background of the face texture.
     * @param {string} [labelColor] - Colour of the label text.
     * @returns {THREE.Material[]}
     */
    function create_d4_materials(
        size,
        margin,
        labels,
        materialOptions,
        bodyColor,
        labelColor
    ) {
        materialOptions = materialOptions || vars.material_options;
        bodyColor = bodyColor || vars.dice_color;
        labelColor = labelColor || vars.label_color;

        /**
         * Creates the special triangular d4 texture.
         *
         * @param {string[]} text
         * @param {string|number} color
         * @param {string|number} back_color
         * @returns {THREE.Texture}
         */
        function create_d4_text(
            text,
            color,
            back_color
        ) {

            var canvas =
                document.createElement(
                    "canvas"
                );

            var context =
                canvas.getContext("2d");

            var ts =
                calc_texture_size(
                    size + margin
                ) * 2;

            canvas.width =
                canvas.height =
                    ts;

            context.font =
                (ts - margin) *
                0.5 +
                "pt Arial";

            context.fillStyle =
                back_color;

            context.fillRect(
                0,
                0,
                canvas.width,
                canvas.height
            );

            context.textAlign =
                "center";

            context.textBaseline =
                "middle";

            context.fillStyle =
                color;

            for (var i in text) {

                context.fillText(
                    text[i],
                    canvas.width / 2,
                    canvas.height / 2 -
                        ts * 0.3
                );

                context.translate(
                    canvas.width / 2,
                    canvas.height / 2
                );

                context.rotate(
                    Math.PI * 2 / 3
                );

                context.translate(
                    -canvas.width / 2,
                    -canvas.height / 2
                );
            }

            var texture =
                new THREE.Texture(
                    canvas
                );

            texture.needsUpdate =
                true;

            return texture;
        }

        var materials = [];
        var bg = colorToCSS(bodyColor);

        for (
            var i = 0;
            i < labels.length;
            ++i
        ) {

            materials.push(
                new THREE.MeshPhongMaterial(
                    $t.copyto(
                        materialOptions,
                        {
                            transparent: true,
                            map:
                                create_d4_text(
                                    labels[i],
                                    labelColor,
                                    bg
                                )
                        }
                    )
                )
            );
        }

        return materials;
    }

    /**
     * Creates d4 geometry.
     *
     * @param {number} radius
     * @returns {THREE.Geometry}
     */
    function create_d4_geometry(radius) {

        var vertices = [
            [1, 1, 1],
            [-1, -1, 1],
            [-1, 1, -1],
            [1, -1, -1]
        ];

        var faces = [
            [1, 0, 2, 1],
            [0, 1, 3, 2],
            [0, 3, 2, 3],
            [1, 2, 3, 4]
        ];

        return create_geom(
            vertices,
            faces,
            radius,
            -0.1,
            Math.PI * 7 / 6,
            0.96
        );
    }

    /**
     * Creates d6 geometry.
     *
     * @param {number} radius
     * @returns {THREE.Geometry}
     */
    function create_d6_geometry(radius) {

        var vertices = [
            [-1, -1, -1],
            [1, -1, -1],
            [1, 1, -1],
            [-1, 1, -1],
            [-1, -1, 1],
            [1, -1, 1],
            [1, 1, 1],
            [-1, 1, 1]
        ];

        var faces = [
            [0, 3, 2, 1, 1],
            [1, 2, 6, 5, 2],
            [0, 1, 5, 4, 3],
            [3, 7, 6, 2, 4],
            [0, 4, 7, 3, 5],
            [4, 5, 6, 7, 6]
        ];

        return create_geom(
            vertices,
            faces,
            radius,
            0.1,
            Math.PI / 4,
            0.96
        );
    }

    /**
     * Creates d8 geometry.
     *
     * @param {number} radius
     * @returns {THREE.Geometry}
     */
    function create_d8_geometry(radius) {

        var vertices = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1]
        ];

        var faces = [
            [0, 2, 4, 1],
            [0, 4, 3, 2],
            [0, 3, 5, 3],
            [0, 5, 2, 4],
            [1, 3, 4, 5],
            [1, 4, 2, 6],
            [1, 2, 5, 7],
            [1, 5, 3, 8]
        ];

        return create_geom(
            vertices,
            faces,
            radius,
            0,
            -Math.PI / 4 / 2,
            0.965
        );
    }

    /**
     * Creates d10 geometry.
     *
     * @param {number} radius
     * @returns {THREE.Geometry}
     */
    function create_d10_geometry(radius) {

        var a =
            Math.PI * 2 / 10;

        var k =
            Math.cos(a);

        var h =
            0.105;

        var v =
            -1;

        var vertices = [];

        for (
            var i = 0, b = 0;
            i < 10;
            ++i, b += a
        ) {

            vertices.push([
                Math.cos(b),
                Math.sin(b),
                h * (i % 2 ? 1 : -1)
            ]);
        }

        vertices.push([
            0,
            0,
            -1
        ]);

        vertices.push([
            0,
            0,
            1
        ]);

        var faces = [
            [5, 7, 11, 0],
            [4, 2, 10, 1],
            [1, 3, 11, 2],
            [0, 8, 10, 3],
            [7, 9, 11, 4],
            [8, 6, 10, 5],
            [9, 1, 11, 6],
            [2, 0, 10, 7],
            [3, 5, 11, 8],
            [6, 4, 10, 9],

            [1, 0, 2, v],
            [1, 2, 3, v],
            [3, 2, 4, v],
            [3, 4, 5, v],
            [5, 4, 6, v],
            [5, 6, 7, v],
            [7, 6, 8, v],
            [7, 8, 9, v],
            [9, 8, 0, v],
            [9, 0, 1, v]
        ];

        return create_geom(
            vertices,
            faces,
            radius,
            0,
            Math.PI * 6 / 5,
            0.945
        );
    }

    /**
     * Creates d12 geometry.
     *
     * @param {number} radius
     * @returns {THREE.Geometry}
     */
    function create_d12_geometry(radius) {

        var p =
            (1 + Math.sqrt(5)) / 2;

        var q =
            1 / p;

        var vertices = [
            [0, q, p],
            [0, q, -p],
            [0, -q, p],
            [0, -q, -p],
            [p, 0, q],
            [p, 0, -q],
            [-p, 0, q],
            [-p, 0, -q],
            [q, p, 0],
            [q, -p, 0],
            [-q, p, 0],
            [-q, -p, 0],
            [1, 1, 1],
            [1, 1, -1],
            [1, -1, 1],
            [1, -1, -1],
            [-1, 1, 1],
            [-1, 1, -1],
            [-1, -1, 1],
            [-1, -1, -1]
        ];

        var faces = [
            [2, 14, 4, 12, 0, 1],
            [15, 9, 11, 19, 3, 2],
            [16, 10, 17, 7, 6, 3],
            [6, 7, 19, 11, 18, 4],
            [6, 18, 2, 0, 16, 5],
            [18, 11, 9, 14, 2, 6],
            [1, 17, 10, 8, 13, 7],
            [1, 13, 5, 15, 3, 8],
            [13, 8, 12, 4, 5, 9],
            [5, 4, 14, 9, 15, 10],
            [0, 12, 8, 10, 16, 11],
            [3, 19, 7, 17, 1, 12]
        ];

        return create_geom(
            vertices,
            faces,
            radius,
            0.2,
            -Math.PI / 4 / 2,
            0.968
        );
    }

    /**
     * Creates d20 geometry.
     *
     * @param {number} radius
     * @returns {THREE.Geometry}
     */
    function create_d20_geometry(radius) {

        var t =
            (1 + Math.sqrt(5)) / 2;

        var vertices = [
            [-1, t, 0],
            [1, t, 0],
            [-1, -t, 0],
            [1, -t, 0],
            [0, -1, t],
            [0, 1, t],
            [0, -1, -t],
            [0, 1, -t],
            [t, 0, -1],
            [t, 0, 1],
            [-t, 0, -1],
            [-t, 0, 1]
        ];

        var faces = [
            [0, 11, 5, 1],
            [0, 5, 1, 2],
            [0, 1, 7, 3],
            [0, 7, 10, 4],
            [0, 10, 11, 5],
            [1, 5, 9, 6],
            [5, 11, 4, 7],
            [11, 10, 2, 8],
            [10, 7, 6, 9],
            [7, 1, 8, 10],
            [3, 9, 4, 11],
            [3, 4, 2, 12],
            [3, 2, 6, 13],
            [3, 6, 8, 14],
            [3, 8, 9, 15],
            [4, 9, 5, 16],
            [2, 4, 11, 17],
            [6, 2, 10, 18],
            [8, 6, 7, 19],
            [9, 8, 1, 20]
        ];

        return create_geom(
            vertices,
            faces,
            radius,
            -0.2,
            -Math.PI / 4 / 2,
            0.955
        );
    }

    // ---------------------------------------------------------------------
    // HELPERS
    // ---------------------------------------------------------------------

    /**
     * @brief Returns the smallest power of two that is greater than or equal to the given size.
     *
     * WebGL renders textures most efficiently when their dimensions are powers of two.
     * This helper ensures canvas textures used for die faces meet that requirement,
     * avoiding potential rendering artifacts or performance penalties.
     *
     * If the provided size is less than 1, the function returns 1 to guarantee a
     * valid canvas dimension.
     *
     * @param {number} size - The original texture size (usually in pixels).
     * @returns {number} The next power-of-two size, or 1 if the input is less than 1.
     */
    function calc_texture_size(size) {
        if (size < 1) return 1;
        return Math.pow(2, Math.ceil(Math.log2(size)));
    }

    /**
     * Returns the array of materials attached to a die mesh, regardless of
     * whether it uses MeshFaceMaterial or a single material.
     */
    function get_die_materials(dice) {
        if (!dice || !dice.material) return [];
        if (Array.isArray(dice.material)) return dice.material;
        if (dice.material.materials) return dice.material.materials;
        return [dice.material];
    }

    /**
     * Converts a colour value (number or string) to a CSS colour string.
     *
     * @param {number|string} color - e.g., 0xff0000 or '#ff0000'
     * @returns {string} CSS colour string like '#ff0000'
     */
    function colorToCSS(color) {
        if (typeof color === 'number') {
            return '#' + ('000000' + color.toString(16)).slice(-6);
        }
        return color;
    }

    /**
     * Returns a random floating point value in [0, 1).
     *
     * This deliberately remains a tiny wrapper around Math.random() so that
     * randomisation can later be replaced by an injected/seeded RNG without
     * touching the rest of the physics code.
     *
     * @returns {number}
     */
    function rnd() {
        if (_rng) return _rng();
        return Math.random();
    }

    /**
     * Creates a Cannon.js convex polyhedron from the geometry definition.
     *
     * @param {Array[]} vertices
     * @param {Array[]} faces
     * @param {number} radius
     * @returns {CANNON.ConvexPolyhedron}
     */
    function create_shape(
        vertices,
        faces,
        radius
    ) {

        var cv =
            new Array(vertices.length);

        var cf =
            new Array(faces.length);

        for (
            var i = 0;
            i < vertices.length;
            ++i
        ) {

            var v =
                vertices[i];

            cv[i] =
                new CANNON.Vec3(
                    v.x * radius,
                    v.y * radius,
                    v.z * radius
                );
        }

        for (
            var i = 0;
            i < faces.length;
            ++i
        ) {

            cf[i] =
                faces[i].slice(
                    0,
                    faces[i].length - 1
                );
        }

        return new CANNON.ConvexPolyhedron(
            cv,
            cf
        );
    }

    /**
     * Creates a Three.js geometry from the supplied polyhedron definition.
     *
     * @param {Array[]} vertices
     * @param {Array[]} faces
     * @param {number} radius
     * @param {number} tab
     * @param {number} af
     * @returns {THREE.Geometry}
     */
    function make_geom(
        vertices,
        faces,
        radius,
        tab,
        af
    ) {

        var geom =
            new THREE.Geometry();

        for (
            var i = 0;
            i < vertices.length;
            ++i
        ) {

            var vertex =
                vertices[i]
                    .multiplyScalar(
                        radius
                    );

            vertex.index =
                geom.vertices.push(
                    vertex
                ) - 1;
        }

        for (
            var i = 0;
            i < faces.length;
            ++i
        ) {

            var ii =
                faces[i];

            var fl =
                ii.length - 1;

            var aa =
                Math.PI * 2 / fl;

            for (
                var j = 0;
                j < fl - 2;
                ++j
            ) {

                geom.faces.push(
                    new THREE.Face3(
                        ii[0],
                        ii[j + 1],
                        ii[j + 2],

                        [
                            geom.vertices[ii[0]],
                            geom.vertices[ii[j + 1]],
                            geom.vertices[ii[j + 2]]
                        ],

                        0,

                        ii[fl] + 1
                    )
                );

                geom.faceVertexUvs[0].push([
                    new THREE.Vector2(
                        (
                            Math.cos(af) +
                            1 +
                            tab
                        ) /
                        2 /
                        (1 + tab),

                        (
                            Math.sin(af) +
                            1 +
                            tab
                        ) /
                        2 /
                        (1 + tab)
                    ),

                    new THREE.Vector2(
                        (
                            Math.cos(
                                aa * (j + 1) +
                                af
                            ) +
                            1 +
                            tab
                        ) /
                        2 /
                        (1 + tab),

                        (
                            Math.sin(
                                aa * (j + 1) +
                                af
                            ) +
                            1 +
                            tab
                        ) /
                        2 /
                        (1 + tab)
                    ),

                    new THREE.Vector2(
                        (
                            Math.cos(
                                aa * (j + 2) +
                                af
                            ) +
                            1 +
                            tab
                        ) /
                        2 /
                        (1 + tab),

                        (
                            Math.sin(
                                aa * (j + 2) +
                                af
                            ) +
                            1 +
                            tab
                        ) /
                        2 /
                        (1 + tab)
                    )
                ]);
            }
        }

        geom.computeFaceNormals();

        geom.boundingSphere =
            new THREE.Sphere(
                new THREE.Vector3(),
                radius
            );

        return geom;
    }

    /**
     * Clears the cached dice geometries so that a subsequent
     * call to threeD_dice.getGeometry() rebuilds them at the current
     * vars.scale. Called whenever vars.scale changes.
     */
    function invalidateGeometryCache() {
        delete threeD_dice.d4_geometry;
        delete threeD_dice.d6_geometry;
        delete threeD_dice.d8_geometry;
        delete threeD_dice.d10_geometry;
        delete threeD_dice.d12_geometry;
        delete threeD_dice.d20_geometry;
    }

    /**
     * Computes the effective world scale for a throw, given the number of
     * physical dice that will be created in the first phase.
     *
     * The dice shrink as the count rises, according to:
     *
     *     factor = clamp((baseline / count) ^ exponent, minFactor, 1)
     *     scale  = baseScale * size_multiplier * factor
     *
     * With the defaults (baseline=6, exponent=0.5, minFactor=0.35):
     *
     *     1–6 dice   -> full base size
     *     12 dice    -> ~71% of base
     *     24 dice    -> ~50% of base
     *     50+ dice   -> ~35% of base (clamped)
     *
     * @param {dice_box} box
     * @param {number} count - physical dice count in the first phase
     */
    function applyScaleForCount(box, count) {
        box._lastDiceCount = count;
        var base = box._baseScale || vars.scale || 100;
        var userMul = Math.max(0.1, vars.size_multiplier || 1.0);

        var factor = 1;
        if (vars.auto_scale_enabled && count > 0) {
            var baseline = Math.max(1, vars.auto_scale_baseline_dice);
            var exp = Math.max(0, vars.auto_scale_exponent);
            var minF = Math.max(0.05, Math.min(1, vars.auto_scale_min_factor));
            factor = Math.pow(baseline / count, exp);
            factor = Math.max(minF, Math.min(1, factor));
        }

        var newScale = base * userMul * factor;

        if (newScale !== vars.scale) {
            vars.scale = newScale;
            invalidateGeometryCache();
        }
    }

    /**
     * Creates the chamfered version of a polyhedron.
     *
     * The original dice geometry algorithm is retained here unchanged in
     * principle. The notation/result refactor deliberately does not reach
     * into geometry generation.
     *
     * @param {THREE.Vector3[]} vectors
     * @param {Array[]} faces
     * @param {number} chamfer
     * @returns {Object}
     */
    function chamfer_geom(
        vectors,
        faces,
        chamfer
    ) {

        var chamfer_vectors = [];
        var chamfer_faces = [];

        var corner_faces =
            new Array(
                vectors.length
            );

        for (
            var i = 0;
            i < vectors.length;
            ++i
        ) {

            corner_faces[i] = [];
        }

        for (
            var i = 0;
            i < faces.length;
            ++i
        ) {

            var ii =
                faces[i];

            var fl =
                ii.length - 1;

            var center_point =
                new THREE.Vector3();

            var face =
                new Array(fl);

            for (
                var j = 0;
                j < fl;
                ++j
            ) {

                var vv =
                    vectors[ii[j]].clone();

                center_point.add(vv);

                corner_faces[ii[j]].push(
                    face[j] =
                        chamfer_vectors.push(vv) -
                        1
                );
            }

            center_point.divideScalar(fl);

            for (
                var j = 0;
                j < fl;
                ++j
            ) {

                var vv =
                    chamfer_vectors[
                        face[j]
                    ];

                vv.subVectors(
                    vv,
                    center_point
                )
                .multiplyScalar(chamfer)
                .addVectors(
                    vv,
                    center_point
                );
            }

            face.push(ii[fl]);

            chamfer_faces.push(
                face
            );
        }

        /*
         * Create the chamfer faces between neighbouring faces.
         */
        for (
            var i = 0;
            i < faces.length - 1;
            ++i
        ) {

            for (
                var j = i + 1;
                j < faces.length;
                ++j
            ) {

                var pairs = [];
                var lastm = -1;

                for (
                    var m = 0;
                    m <
                        faces[i].length - 1;
                    ++m
                ) {

                    var n =
                        faces[j].indexOf(
                            faces[i][m]
                        );

                    if (
                        n >= 0 &&
                        n <
                            faces[j].length - 1
                    ) {

                        if (
                            lastm >= 0 &&
                            m != lastm + 1
                        ) {

                            pairs.unshift(
                                [i, m],
                                [j, n]
                            );
                        }
                        else {

                            pairs.push(
                                [i, m],
                                [j, n]
                            );
                        }

                        lastm = m;
                    }
                }

                if (pairs.length != 4) {
                    continue;
                }

                chamfer_faces.push([
                    chamfer_faces[
                        pairs[0][0]
                    ][
                        pairs[0][1]
                    ],

                    chamfer_faces[
                        pairs[1][0]
                    ][
                        pairs[1][1]
                    ],

                    chamfer_faces[
                        pairs[3][0]
                    ][
                        pairs[3][1]
                    ],

                    chamfer_faces[
                        pairs[2][0]
                    ][
                        pairs[2][1]
                    ],

                    -1
                ]);
            }
        }

        /*
         * Create the chamfered corner faces.
         */
        for (
            var i = 0;
            i < corner_faces.length;
            ++i
        ) {

            var cf =
                corner_faces[i];

            var face =
                [cf[0]];

            var count =
                cf.length - 1;

            while (count) {

                for (
                    var m = faces.length;
                    m < chamfer_faces.length;
                    ++m
                ) {

                    var index =
                        chamfer_faces[m].indexOf(
                            face[
                                face.length - 1
                            ]
                        );

                    if (
                        index >= 0 &&
                        index < 4
                    ) {

                        if (--index == -1) {
                            index = 3;
                        }

                        var next_vertex =
                            chamfer_faces[m][index];

                        if (
                            cf.indexOf(
                                next_vertex
                            ) >= 0
                        ) {

                            face.push(
                                next_vertex
                            );

                            break;
                        }
                    }
                }

                --count;
            }

            face.push(-1);

            chamfer_faces.push(
                face
            );
        }

        return {
            vectors: chamfer_vectors,
            faces: chamfer_faces
        };
    }

    /**
     * Builds the complete Three.js/Cannon.js geometry.
     *
     * @param {Array[]} vertices
     * @param {Array[]} faces
     * @param {number} radius
     * @param {number} tab
     * @param {number} af
     * @param {number} chamfer
     * @returns {THREE.Geometry}
     */
    function create_geom(
        vertices,
        faces,
        radius,
        tab,
        af,
        chamfer
    ) {

        var vectors =
            new Array(
                vertices.length
            );

        for (
            var i = 0;
            i < vertices.length;
            ++i
        ) {

            vectors[i] =
                (new THREE.Vector3)
                    .fromArray(
                        vertices[i]
                    )
                    .normalize();
        }

        var cg =
            chamfer_geom(
                vectors,
                faces,
                chamfer
            );

        var geom =
            make_geom(
                cg.vectors,
                cg.faces,
                radius,
                tab,
                af
            );

        geom.cannon_shape =
            create_shape(
                vectors,
                faces,
                radius
            );

        return geom;
    }

    /**
     * Creates a slightly randomised throw direction.
     *
     * This gives individual physical dice within the same throw slightly
     * different trajectories, preventing every die from following exactly
     * the same path.
     *
     * @param {Object} vector
     * @returns {Object}
     */
    function make_random_vector(vector) {

        var random_angle =
            rnd() *
            Math.PI / 5 -
            Math.PI / 5 / 2;

        var vec = {

            x:
                vector.x *
                    Math.cos(random_angle) -
                vector.y *
                    Math.sin(random_angle),

            y:
                vector.x *
                    Math.sin(random_angle) +
                vector.y *
                    Math.cos(random_angle)
        };

        /*
         * Prevent division by zero later when calculating the launch
         * position.
         */
        if (vec.x == 0) {
            vec.x = 0.01;
        }

        if (vec.y == 0) {
            vec.y = 0.01;
        }

        return vec;
    }

    /**
     * Calculates the currently visible face of a physical die.
     *
     * The face whose normal points closest to the camera/up direction is
     * considered the result.
     *
     * d4 uses the opposite direction because of the orientation of its
     * geometry.
     *
     * @param {THREE.Mesh} dice
     * @returns {number}
     */
    function get_dice_value(dice) {
        if (isNaN(dice.body.position.x) || isNaN(dice.body.quaternion.x) ||
            isNaN(dice.body.velocity.x) || isNaN(dice.body.angularVelocity.x)) {
            console.warn('[nan-body]', dice.dice_id, dice.dice_type,
                'pos', dice.body.position,
                'quat', dice.body.quaternion,
                'vel', dice.body.velocity,
                'ang', dice.body.angularVelocity);
        }

        var vector =
            new THREE.Vector3(
                0,
                0,
                dice.dice_type == 'd4'
                    ? -1
                    : 1
            );

        var closest_face;
        var closest_angle =
            Math.PI * 2;

        for (
            var i = 0,
            l = dice.geometry.faces.length;
            i < l;
            ++i
        ) {

            var face =
                dice.geometry.faces[i];

            /*
             * Material zero is the blank/internal material and is not a
             * numbered face.
             */
            if (
                face.materialIndex == 0
            ) {
                continue;
            }

            var angle =
                face.normal
                    .clone()
                    .applyQuaternion(
                        dice.body.quaternion
                    )
                    .angleTo(
                        vector
                    );

            if (
                angle < closest_angle
            ) {

                closest_angle = angle;
                closest_face = face;
            }
        }

        /*
         * It is theoretically possible for no numbered face to be found.
         * Preserve the original fallback behaviour rather than throwing.
         */
        var matindex =
            closest_face
                ? closest_face.materialIndex - 1
                : -1;

        /*
         * d100 uses percentile faces on d10 geometry.
         */
        if (
            dice.dice_type == 'd100'
        ) {

            matindex *= 10;
        }

        /*
         * d10 internally uses 0 for the face which is publicly exposed as 10.
         */
        if (
            dice.dice_type == 'd10' &&
            matindex == 0
        ) {
            matindex = 10;
        }

        if (
            dice.dice_type == 'd9' && matindex == 0
        ) {
            matindex = 9;
        }

        return matindex;
    }

    /**
     * Converts the physical dice meshes into rich result objects.
     *
     * Every physical die is returned, including dice which will subsequently
     * be dropped by a keep/drop rule.
     *
     * Example:
     *
     *     {
     *         diceId: 3,
     *         groupId: 1,
     *         type: 'd20',
     *         value: 17,
     *         kept: true
     *     }
     *
     * The result evaluator later changes kept=false where appropriate.
     *
     * @param {THREE.Mesh[]} dices
     * @returns {Object[]}
     */
    function get_dice_values(dices) {

        var values = [];

        for (
            var i = 0;
            i < dices.length;
            ++i
        ) {

            var dice =
                dices[i];

            values.push({

                diceId:
                    dice.dice_id,

                groupId:
                    dice.group_id,

                type:
                    dice.dice_type,

                value:
                    get_dice_value(
                        dice
                    ),

                /*
                 * Every physical die starts kept.
                 *
                 * The rules engine changes this after the physical roll.
                 */
                kept: true
            });
        }

        return values;
    }

    /**
     * Shifts a die's visible face labels so that the requested value becomes
     * the eventual result.
     *
     * This is used when an external caller supplies authoritative results.
     * For compound dice, the caller provides the full combined value (1-100),
     * and this function splits it into tens and units, shifting each die accordingly.
     *
     * @param {THREE.Mesh} dice
     * @param {number} value - The value to shift this die to (already split for compound)
     * @param {number} res - The current face value of this die
     */
    function shift_dice_faces(
        dice,
        value,
        res
    ) {

        var r =
            CONSTS.dice_face_range[
                dice.dice_type
            ];

        /*
         * Public d10 value 10 corresponds to internal face 0.
         */
        if (
            dice.dice_type == 'd10' &&
            value == 10
        ) {

            value = 0;
        }

        /*
         * Public d9 value 9 corresponds to internal face 0.
         */
        if (
            dice.dice_type == 'd9' &&
            value == 9
        ) {

            value = 0;
        }

        /*
         * Ignore invalid requested values.
         */
        if (
            !(
                value >= r[0] &&
                value <= r[1]
            )
        ) {

            return;
        }

        var num =
            value - res;

        var geom =
            dice.geometry.clone();

        for (
            var i = 0,
            l = geom.faces.length;
            i < l;
            ++i
        ) {

            var matindex =
                geom.faces[i]
                    .materialIndex;

            if (
                matindex == 0
            ) {
                continue;
            }

            matindex +=
                num - 1;

            while (
                matindex > r[1]
            ) {

                matindex -=
                    r[1];
            }

            while (
                matindex < r[0]
            ) {

                matindex +=
                    r[1];
            }

            geom.faces[i]
                .materialIndex =
                    matindex + 1;
        }

        /*
         * d4 requires regenerating its special face-label material because
         * the triangular labels depend on orientation.
         * Use the stored body colour.
         */
        if (dice.dice_type == 'd4' && num != 0) {
            if (num < 0) {
                num += 4;
            }

            // Store the new variant number on the die
            dice.d4_variant = num;

            var materialOptions = $t.copyto(vars.material_options, { color: 0xffffff });
            dice.material =
                new THREE.MeshFaceMaterial(
                    create_d4_materials(
                        vars.scale / 2,
                        vars.scale * 2,
                        CONSTS.d4_labels[num],
                        materialOptions,
                        dice.body_color
                    )
                );
        }

        dice.geometry =
            geom;
    }

    return that;

}());