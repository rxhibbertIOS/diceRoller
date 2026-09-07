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
 *
 * @author Anton Natarov aka Teal (original author)
 * @author Sarah Rosanna Busch (refactor, see changelog)
 * @author Rory Hibbert (refactor, see changelog)
 * @date 10 Aug 2023
 * @version 1.2
 * @dependencies teal.js, cannon.js, three.js
 */


/**
 * CHANGELOG - Sarah Rosanna Busch
 *
 * - Tweaked scaling to make dice look nice on mobile.
 * - Removed dice selector feature (separating UI from dice roller).
 * - Reorganised file structure.
 * - Removed true random option.
 * - Removed mouse event bindings.
 * - Refactored into module pattern.
 * - Reduced publicly available properties/methods.
 * - Removed dice notation getter callback in favour of setting dice
 *   to roll directly.
 * - Added roll results to notation returned in after_roll callback.
 * - Added d9 option.
 */


/**
 * CHANGELOG - Rory Hibbert
 *
 * - Removed sound effects.
 * - Added structured dice groups.
 * - Added physical dice IDs.
 * - Added group IDs to physical dice.
 * - Added structured keep/drop rules.
 * - Added group-aware result evaluation.
 * - Added deterministic tie-breaking for keep/drop rules.
 * - Added rich dice result objects.
 * - Preserved backwards compatibility for notation.result.
 * - Added notation.diceResults for rich result information.
 * - Updated stringify_notation() to preserve rules.
 * - Added feature to change colour of 'dropped' dice.
 */


/**
 * Main dice module.
 *
 * The module uses the original library's singleton/module pattern so that
 * existing consumers can continue to use:
 *
 *     const box = new DICE.dice_box(container);
 *
 * The physics and rendering implementation remains intentionally separate
 * from notation parsing and result evaluation.
 */
const DICE = (function() {

    var that = {};


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
         * Adaptive timestep produces more natural-looking animation.
         *
         * Setting this to false improves performance but changes the visual
         * character of the roll.
         */
        use_adapvite_timestep: true,

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
        ]
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
         */
        dice_face_range: {
            'd4': [1, 4],
            'd6': [1, 6],
            'd8': [1, 8],
            'd9': [0, 9],
            'd10': [0, 9],
            'd12': [1, 12],
            'd20': [1, 20],
            'd100': [0, 9]
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


        $t.bind(container, 'resize', function() {

            /*
             * Fixed: use this.container instead of undefined elem.canvas
             */
            this.reinit(this.container);
        });


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


        this.world.addContactMaterial(
            new CANNON.ContactMaterial(
                desk_body_material,
                this.dice_body_material,
                0.01,
                0.5
            )
        );

        this.world.addContactMaterial(
            new CANNON.ContactMaterial(
                barrier_body_material,
                this.dice_body_material,
                0,
                1.0
            )
        );

        this.world.addContactMaterial(
            new CANNON.ContactMaterial(
                this.dice_body_material,
                this.dice_body_material,
                0,
                0.5
            )
        );


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

        barrier = new CANNON.RigidBody(
            0,
            new CANNON.Plane(),
            barrier_body_material
        );

        barrier.quaternion.setFromAxisAngle(
            new CANNON.Vec3(1, 0, 0),
            Math.PI / 2
        );

        barrier.position.set(
            0,
            this.h * 0.93,
            0
        );

        this.world.add(barrier);


        barrier = new CANNON.RigidBody(
            0,
            new CANNON.Plane(),
            barrier_body_material
        );

        barrier.quaternion.setFromAxisAngle(
            new CANNON.Vec3(1, 0, 0),
            -Math.PI / 2
        );

        barrier.position.set(
            0,
            -this.h * 0.93,
            0
        );

        this.world.add(barrier);


        barrier = new CANNON.RigidBody(
            0,
            new CANNON.Plane(),
            barrier_body_material
        );

        barrier.quaternion.setFromAxisAngle(
            new CANNON.Vec3(0, 1, 0),
            -Math.PI / 2
        );

        barrier.position.set(
            this.w * 0.93,
            0,
            0
        );

        this.world.add(barrier);


        barrier = new CANNON.RigidBody(
            0,
            new CANNON.Plane(),
            barrier_body_material
        );

        barrier.quaternion.setFromAxisAngle(
            new CANNON.Vec3(0, 1, 0),
            Math.PI / 2
        );

        barrier.position.set(
            -this.w * 0.93,
            0,
            0
        );

        this.world.add(barrier);


        this.last_time = 0;
        this.running = false;

        this.renderer.render(
            this.scene,
            this.camera
        );
    };


    /**
     * Reinitialises camera, lighting and desk dimensions.
     *
     * Called during initialisation and whenever the container is resized.
     *
     * @param {HTMLElement} container
     */
    that.dice_box.prototype.reinit = function(container) {

        this.cw = container.clientWidth / 2;
        this.ch = container.clientHeight / 2;

        this.w = this.cw;
        this.h = this.ch;

        this.aspect = Math.min(
            this.cw / this.w,
            this.ch / this.h
        );

        vars.scale =
            Math.sqrt(
                this.w * this.w +
                this.h * this.h
            ) / 8;


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


        this.renderer.render(
            this.scene,
            this.camera
        );
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
     *
     * @param {string} diceToRoll
     */
    that.dice_box.prototype.setDice = function(diceToRoll) {
        this.diceToRoll = diceToRoll;
    };


    /**
     * Starts a programmatic dice throw.
     *
     * @param {Function} before_roll
     *        Optional callback called after parsing but before physics begins.
     *
     *        The callback receives the parsed notation object and may return
     *        an array of desired numeric dice results. This is useful when
     *        the application already has authoritative results and only wants
     *        the 3D dice to visually reproduce them.
     *
     * @param {Function} after_roll
     *        Optional callback called after the physical roll has completed
     *        and the results have been evaluated.
     */
    that.dice_box.prototype.start_throw = function(
        before_roll,
        after_roll
    ) {

        console.log('Dice Roll: Starting throw with notation:', this.diceToRoll);

        var box = this;

        if (box.rolling) {
            console.warn('Dice Roll: Already rolling, ignoring request.');
            return;
        }


        var vector = {
            x: (rnd() * 2 - 1) * box.w,
            y: -(rnd() * 2 - 1) * box.h
        };


        var dist = Math.sqrt(
            vector.x * vector.x +
            vector.y * vector.y
        );


        var boost = (rnd() + 3) * dist;


        throw_dices(
            box,
            vector,
            boost,
            dist,
            before_roll,
            after_roll
        );
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


                if (
                    dist <
                    Math.sqrt(box.w * box.h * 0.01)
                ) {
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


                throw_dices(
                    box,
                    vector,
                    boost,
                    dist,
                    before_roll,
                    after_roll
                );
            }
        );
    };


    /**
     * Performs a complete throw lifecycle.
     *
     * The important distinction here is between:
     *
     *   notation.result
     *       Backwards-compatible numeric array containing ONLY kept results.
     *
     *   notation.diceResults
     *       Rich result objects for every physical die, including dropped
     *       dice and metadata identifying their group and physical die.
     *
     * Keeping these separate means existing consumers of the original API
     * do not suddenly receive objects instead of numbers.
     *
     * @param {Object} box
     * @param {Object} vector
     * @param {number} boost
     * @param {number} dist
     * @param {Function} before_roll
     * @param {Function} after_roll
     */
    function throw_dices(
        box,
        vector,
        boost,
        dist,
        before_roll,
        after_roll
    ) {

        var uat = vars.use_adapvite_timestep;


        /*
         * Convert the throw vector into a direction.
         */
        vector.x /= dist;
        vector.y /= dist;


        /*
         * Parse the original notation once for this throw.
         */
        var notation = that.parse_notation(
            box.diceToRoll
        );

        console.log('Dice Roll: Parsed notation:', notation);

        /*
         * No physical dice means there is nothing to animate.
         */
        if (notation.set.length == 0) {
            console.warn('Dice Roll: No dice to roll, aborting.');
            return;
        }


        /*
         * Create one physical vector for every die.
         *
         * generate_vectors() expands the logical groups into individual
         * physical dice while retaining group metadata.
         */
        var vectors = box.generate_vectors(
            notation,
            vector,
            boost
        );

        console.log('Dice Roll: Generated ' + vectors.length + ' physical dice.');


        box.rolling = true;


        let request_results = null;


        /*
         * Allow the application to provide authoritative numeric results.
         *
         * IMPORTANT:
         *
         * request_results is deliberately an array of numbers.
         * It is not notation.diceResults.
         *
         * This allows roll() to shift the visual faces to the requested
         * results while still letting the physical dice animate normally.
         */
        if (before_roll) {
            request_results = before_roll(notation);
            if (request_results && request_results.length) {
                console.log('Dice Roll: Forced results provided:', request_results);
            }
        }


        roll(request_results);


        /**
         * Performs the visual roll.
         *
         * @param {number[]} request_results
         *        Optional authoritative numeric results.
         */
        function roll(request_results) {

            box.clear();


            box.roll(
                vectors,

                /*
                 * If the caller did not provide results, notation.result
                 * contains the numeric results from the parsed notation.
                 *
                 * During a normal roll this is empty, so the dice are
                 * physically rolled.
                 */
                request_results || notation.result,


                function(diceResults) {

                    console.log('Dice Roll: Physics finished, evaluating results.');

                    /*
                     * Evaluate all physical dice against their logical groups
                     * and rules.
                     */
                    notation.diceResults =
                        evaluate_results(
                            notation,
                            diceResults
                        );

                    /** apply the visuals change for dropped dice */
                    apply_dropped_visuals(notation.diceResults, box.dices);

                    // Force a render to show the updated dropped dice visuals
                    box.renderer.render(box.scene, box.camera);

                    /*
                     * Preserve the original public API:
                     *
                     * notation.result remains a numeric array.
                     *
                     * Only dice which survived their group's keep/drop
                     * evaluation are included.
                     */
                    notation.result = [];


                    for (
                        var i = 0;
                        i < notation.diceResults.length;
                        i++
                    ) {

                        if (
                            notation.diceResults[i].kept
                        ) {

                            notation.result.push(
                                notation.diceResults[i].value
                            );
                        }
                    }


                    /*
                     * Calculate the final numeric result from the evaluated
                     * dice rather than from the raw physical results.
                     */
                    notation.resultTotal =
                        calculate_result(
                            notation.diceResults,
                            notation.constant
                        );


                    /*
                     * Build the printable result from the kept numeric values.
                     *
                     * This deliberately excludes dropped dice from the
                     * traditional result string.
                     */
                    var values = [];


                    for (
                        var i = 0;
                        i < notation.result.length;
                        i++
                    ) {

                        values.push(
                            notation.result[i]
                        );
                    }


                    var res = values.join(' ');


                    /*
                     * Add the constant modifier.
                     */
                    if (notation.constant) {

                        if (notation.constant > 0) {

                            res +=
                                ' +' +
                                notation.constant;

                        }
                        else {

                            res +=
                                ' -' +
                                Math.abs(notation.constant);
                        }
                    }


                    /*
                     * Only display "= total" when there is more than one
                     * result or a constant modifier, matching the behaviour
                     * of the original library.
                     */
                    if (
                        values.length > 1 ||
                        notation.constant
                    ) {

                        res +=
                            ' = ' +
                            notation.resultTotal;
                    }


                    notation.resultString = res;

                    console.log('Dice Roll: Final result string:', res);
                    console.log('Dice Roll: Detailed dice results:', notation.diceResults);

                    /*
                     * The callback receives the complete notation object,
                     * including both the backwards-compatible result array
                     * and the new rich diceResults array.
                     */
                    if (after_roll) {
                        after_roll(notation);
                    }


                    box.rolling = false;
                    vars.use_adapvite_timestep = uat;
                }
            );
        }
    }


    /**
     * Generates the initial physical state for every die in a notation.
     *
     * The notation groups are expanded into individual physical dice here.
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

        var vectors = [];

        var dieId = 0;


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
             */
            var groupColor;
            if (group.visual && group.visual.color !== undefined) {
                groupColor = group.visual.color;
            } else {
                groupColor = vars.preset_colours[group.id % vars.preset_colours.length];
            }


            for (
                var dieIndex = 0;
                dieIndex < group.count;
                dieIndex++
            ) {

                var vec = make_random_vector(vector);


                var pos = {
                    x:
                        this.w *
                        (vec.x > 0 ? -1 : 1) *
                        0.9,

                    y:
                        this.h *
                        (vec.y > 0 ? -1 : 1) *
                        0.9,

                    z:
                        rnd() * 200 +
                        200
                };


                var projector =
                    Math.abs(
                        vec.x / vec.y
                    );


                if (projector > 1.0) {
                    pos.y /= projector;
                }
                else {
                    pos.x *= projector;
                }


                var velvec =
                    make_random_vector(vector);


                var velocity = {
                    x: velvec.x * boost,
                    y: velvec.y * boost,
                    z: -10
                };


                var inertia =
                    CONSTS.dice_inertia[
                        group.type
                    ];


                var angle = {
                    x:
                        -(
                            rnd() *
                            vec.y *
                            5 +
                            inertia *
                            vec.y
                        ),

                    y:
                        rnd() *
                        vec.x *
                        5 +
                        inertia *
                        vec.x,

                    z: 0
                };


                var axis = {
                    x: rnd(),
                    y: rnd(),
                    z: rnd(),
                    a: rnd()
                };


                vectors.push({
                    id: dieId++,

                    groupId: group.id,

                    /*
                     * Retained because existing code expects physical
                     * vectors to expose "set".
                     */
                    set: group.type,

                    pos: pos,
                    velocity: velocity,
                    angle: angle,
                    axis: axis,

                    color: groupColor
                });
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
     */
    that.dice_box.prototype.create_dice = function(
        type,
        pos,
        velocity,
        angle,
        axis,
        id,
        groupId,
        color
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
     *        Rich physical dice result objects.
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


        if (vars.use_adapvite_timestep) {

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
                vars.use_adapvite_timestep
            );
        }
    };


    /**
     * Removes all current physical dice from the scene and physics world.
     */
    that.dice_box.prototype.clear = function() {

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
                vector.color   // Pass the colour from the vector
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
    that.dice_box.prototype.roll = function(
        vectors,
        values,
        callback
    ) {

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
            vars.use_adapvite_timestep = false;


            var res =
                this.emulate_throw();


            /*
             * Recreate the original throw state before the visible faces are
             * shifted. This keeps the animation starting point consistent.
             */
            this.prepare_dices_for_roll(
                vectors
            );


            for (
                var i = 0;
                i < res.length;
                i++
            ) {

                /*
                 * values[i] is deliberately numeric.
                 *
                 * res[i] is a rich result object, so shift_dice_faces()
                 * receives res[i].value rather than the object itself.
                 */
                shift_dice_faces(
                    this.dices[i],
                    values[i],
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


    // ---------------------------------------------------------------------
    // NOTATION
    // ---------------------------------------------------------------------


    /**
     * Parses a dice notation string.
     *
     * Supported examples:
     *
     *     1d20
     *     d20
     *     3d6
     *     3d6 + 1d20 + 1d10
     *     2d20kh1
     *     2d20kl1
     *     4d6dl1
     *     4d6dh1
     *     3d6 + 5
     *
     * Supported rules:
     *
     *     kh = keep highest
     *     kl = keep lowest
     *     dh = drop highest
     *     dl = drop lowest
     *
     * The parser deliberately produces structured rules rather than retaining
     * shorthand strings. This means later rules such as rerolls, exploding
     * dice or Lucky-style mechanics can be represented without changing the
     * physics layer.
     *
     * Example group:
     *
     *     {
     *         id: 0,
     *         count: 4,
     *         type: 'd6',
     *         rule: {
     *             type: 'drop-lowest',
     *             count: 1
     *         },
     *         visual: null
     *     }
     *
     * Limits:
     *   - Maximum 10 groups per roll.
     *   - Maximum 10 dice per group.
     *
     * @param {string} notation
     * @returns {Object}
     */
    that.parse_notation = function(notation) {

        var ret = {
            groups: [],

            /*
             * Flattened physical die list retained for backwards
             * compatibility with the original implementation.
             */
            set: [],

            constant: 0,

            /*
             * Numeric kept results. This remains the compatibility-facing
             * result property.
             */
            result: [],

            /*
             * Rich result objects for every physical die.
             */
            diceResults: [],

            resultTotal: 0,
            resultString: '',
            error: false
        };


        /*
         * Only the standard RPG dice currently supported by the parser.
         *
         * d9 remains a known geometry for compatibility, but is not exposed
         * through this notation grammar yet.
         */
        var supportedDice = [
            'd4',
            'd6',
            'd8',
            'd10',
            'd12',
            'd20',
            'd100'
        ];


        /*
         * A missing notation is treated as invalid rather than throwing.
         */
        if (
            typeof notation !== 'string' ||
            notation.trim().length === 0
        ) {

            ret.error = true;
            console.warn('Dice Roll: Empty or invalid notation string.');
            return ret;
        }


        /*
         * The old parser allowed an '@' suffix for externally supplied
         * results. That behaviour is retained by simply parsing the notation
         * portion before '@'.
         *
         * Result injection itself is handled by before_roll.
         */
        var source =
            notation
                .split('@')[0]
                .replace(/\s+/g, '');


        if (source.length === 0) {
            ret.error = true;
            console.warn('Dice Roll: Notation contains only whitespace after removing @.');
            return ret;
        }


        /*
         * Split the expression into signed terms.
         *
         * "3d6+1d20-2+4d8"
         *
         * becomes:
         *
         *   3d6
         *   +1d20
         *   -2
         *   +4d8
         *
         * A leading '+' or '-' is permitted.
         */
        var terms =
            source.split(/(?=[+-])/);


        for (
            var termIndex = 0;
            termIndex < terms.length;
            termIndex++
        ) {

            var term =
                terms[termIndex];


            if (!term) {
                ret.error = true;
                continue;
            }


            /*
             * Extract the sign.
             */
            var sign = 1;


            if (term.charAt(0) === '+') {

                term = term.substring(1);
            }
            else if (term.charAt(0) === '-') {

                sign = -1;
                term = term.substring(1);
            }


            if (!term) {
                ret.error = true;
                continue;
            }


            /*
             * Dice term.
             *
             * count:
             *     Optional number of dice. Defaults to one.
             *
             * sides:
             *     d4, d6, d8, d10, d12, d20 or d100.
             *
             * rule:
             *     Optional kh, kl, dh or dl.
             *
             * ruleCount:
             *     Required when a rule is supplied.
             */
            var diceMatch =
                term.match(
                    /^(\d*)d(\d+)(kh|kl|dh|dl)?(\d+)?$/i
                );


            if (diceMatch) {

                /*
                 * Dice terms may not be negative.
                 */
                if (sign < 0) {
                    ret.error = true;
                    console.warn('Dice Roll: Negative dice term not allowed:', term);
                    continue;
                }


                var count =
                    diceMatch[1] === ''
                        ? 1
                        : parseInt(
                            diceMatch[1],
                            10
                        );


                var type =
                    'd' +
                    diceMatch[2];


                var ruleCode =
                    diceMatch[3]
                        ? diceMatch[3].toLowerCase()
                        : null;


                var ruleCount =
                    diceMatch[4]
                        ? parseInt(
                            diceMatch[4],
                            10
                        )
                        : null;


                /*
                 * Reject zero dice.
                 */
                if (count <= 0) {
                    ret.error = true;
                    console.warn('Dice Roll: Dice count must be > 0.');
                    continue;
                }

                /*
                 * Limit: maximum 10 dice per group.
                 */
                if (count > 10) {
                    ret.error = true;
                    console.warn('Dice Roll: Maximum 10 dice per group (got ' + count + ').');
                    continue;
                }


                /*
                 * Reject unsupported dice.
                 */
                if (
                    supportedDice.indexOf(type) === -1
                ) {

                    ret.error = true;
                    console.warn('Dice Roll: Unsupported dice type:', type);
                    continue;
                }


                /*
                 * A rule requires a positive count.
                 */
                if (
                    ruleCode &&
                    (
                        ruleCount === null ||
                        ruleCount <= 0
                    )
                ) {

                    ret.error = true;
                    console.warn('Dice Roll: Invalid rule count for', term);
                    continue;
                }


                /*
                 * A keep/drop count cannot exceed the number of dice in
                 * the group.
                 */
                if (
                    ruleCode &&
                    ruleCount > count
                ) {

                    ret.error = true;
                    console.warn('Dice Roll: Rule count (' + ruleCount + ') exceeds dice count (' + count + ').');
                    continue;
                }


                var rule = null;


                switch (ruleCode) {

                    case 'kh':

                        rule = {
                            type: 'keep-highest',
                            count: ruleCount
                        };

                        break;


                    case 'kl':

                        rule = {
                            type: 'keep-lowest',
                            count: ruleCount
                        };

                        break;


                    case 'dh':

                        rule = {
                            type: 'drop-highest',
                            count: ruleCount
                        };

                        break;


                    case 'dl':

                        rule = {
                            type: 'drop-lowest',
                            count: ruleCount
                        };

                        break;
                }


                /*
                 * Create a logical group.
                 *
                 * visual is intentionally data-only. It must not contain
                 * Three.js materials because parsing should remain independent
                 * from the renderer.
                 */
                var group = {
                    id: ret.groups.length,
                    count: count,
                    type: type,
                    rule: rule,

                    /*
                     * Reserved for future per-group presentation settings,
                     * e.g.:
                     *
                     * {
                     *     diceColour: '#3498db',
                     *     labelColour: '#aaaaaa'
                     * }
                     */
                    visual: null
                };


                ret.groups.push(group);

                /*
                 * Limit: maximum 10 groups.
                 */
                if (ret.groups.length > 10) {
                    ret.error = true;
                    console.warn('Dice Roll: Maximum 10 groups allowed (got ' + ret.groups.length + ').');
                    // Remove the last group to keep within limit
                    ret.groups.pop();
                    // Break out of loop? We'll just continue and later mark error.
                }


                /*
                 * Maintain the flattened set used by the physical dice
                 * generation code and by existing consumers.
                 */
                for (
                    var i = 0;
                    i < count;
                    i++
                ) {

                    ret.set.push(type);
                }


                continue;
            }


            /*
             * Constant term.
             *
             * Examples:
             *
             *     +5
             *     -2
             *     5
             */
            var constantMatch =
                term.match(
                    /^\d+$/
                );


            if (constantMatch) {

                ret.constant +=
                    sign *
                    parseInt(
                        term,
                        10
                    );

                continue;
            }


            /*
             * Anything which reaches this point is invalid notation.
             *
             * We mark the whole parse as erroneous but continue processing
             * so callers still receive a safe result object.
             */
            ret.error = true;
            console.warn('Dice Roll: Unrecognised term:', term);
        }


        /*
         * A valid notation must contain at least one physical die.
         *
         * A constant-only expression such as "5" is therefore not a valid
         * dice roll.
         */
        if (ret.set.length === 0) {
            ret.error = true;
            console.warn('Dice Roll: No dice in notation (constant-only expressions are not allowed).');
        }


        if (!ret.error) {
            console.log('Dice Roll: Notation parsed successfully. Groups:', ret.groups.length, 'Dice:', ret.set.length);
        } else {
            console.warn('Dice Roll: Notation parse had errors. Results may be incomplete.');
        }

        return ret;
    };


    /**
     * Converts a parsed notation object back into dice notation.
     *
     * Unlike the original implementation, this function serialises the
     * logical groups rather than merely counting entries in the flattened
     * "set" array.
     *
     * This is important because:
     *
     *     2d20kh1
     *
     * must remain:
     *
     *     2d20kh1
     *
     * rather than becoming:
     *
     *     2d20
     *
     * Groups are kept separate deliberately. Therefore:
     *
     *     2d20 + 2d20kh1
     *
     * remains two logical groups even though both groups contain d20s.
     *
     * @param {Object} nn
     * @returns {string}
     */
    that.stringify_notation = function(nn) {

        var notation = '';


        /*
         * Prefer structured groups.
         *
         * The fallback to nn.set keeps this helper compatible with notation
         * objects produced by older versions of the library.
         */
        if (
            nn &&
            Array.isArray(nn.groups) &&
            nn.groups.length
        ) {

            for (
                var i = 0;
                i < nn.groups.length;
                i++
            ) {

                var group =
                    nn.groups[i];


                if (notation.length) {
                    notation += ' + ';
                }


                /*
                 * A single die is conventionally represented as "d20".
                 */
                if (group.count !== 1) {
                    notation += group.count;
                }


                notation += group.type;


                if (group.rule) {

                    switch (group.rule.type) {

                        case 'keep-highest':

                            notation +=
                                'kh' +
                                group.rule.count;

                            break;


                        case 'keep-lowest':

                            notation +=
                                'kl' +
                                group.rule.count;

                            break;


                        case 'drop-highest':

                            notation +=
                                'dh' +
                                group.rule.count;

                            break;


                        case 'drop-lowest':

                            notation +=
                                'dl' +
                                group.rule.count;

                            break;
                    }
                }
            }
        }
        else {

            /*
             * Legacy fallback.
             */
            var dict = {};


            for (
                var i = 0;
                i < nn.set.length;
                i++
            ) {

                if (!dict[nn.set[i]]) {
                    dict[nn.set[i]] = 1;
                }
                else {
                    ++dict[nn.set[i]];
                }
            }


            for (var type in dict) {

                if (notation.length) {
                    notation += ' + ';
                }


                notation +=
                    (
                        dict[type] > 1
                            ? dict[type]
                            : ''
                    ) +
                    type;
            }
        }


        /*
         * Append the constant modifier.
         */
        if (nn.constant) {

            if (notation.length) {

                if (nn.constant > 0) {
                    notation += ' + ' + nn.constant;
                }
                else {
                    notation +=
                        ' - ' +
                        Math.abs(nn.constant);
                }
            }
            else {

                notation +=
                    nn.constant;
            }
        }


        return notation;
    };


    // ---------------------------------------------------------------------
    // PRIVATE DICE RESULT ENGINE
    // ---------------------------------------------------------------------


    /**
     * Evaluates the raw physical dice results against the logical groups.
     *
     * Every physical die starts as kept=true.
     *
     * Rules are then evaluated independently within each group.
     *
     * This is important for expressions such as:
     *
     *     2d20kh1 + 3d6
     *
     * The d20 rule only applies to its two d20s. It must never accidentally
     * compare those dice against the d6 results.
     *
     * Tie behaviour:
     *
     * Rules always keep/drop exactly the requested number of physical dice.
     *
     * For example:
     *
     *     2d20kh1
     *
     * with:
     *
     *     [17, 17]
     *
     * still keeps exactly one physical die.
     *
     * The diceId is used as a deterministic tie-breaker. There is no special
     * game-rule meaning attached to which tied physical die wins.
     *
     * @param {Object} notation
     * @param {Object[]} diceResults
     * @returns {Object[]}
     */
    function evaluate_results(
        notation,
        diceResults
    ) {

        /*
         * Evaluate each logical group independently.
         */
        for (
            var groupIndex = 0;
            groupIndex < notation.groups.length;
            groupIndex++
        ) {

            var group =
                notation.groups[groupIndex];


            /*
             * Gather only physical dice belonging to this group.
             */
            var groupDice = [];


            for (
                var dieIndex = 0;
                dieIndex < diceResults.length;
                dieIndex++
            ) {

                if (
                    diceResults[dieIndex].groupId ===
                    group.id
                ) {

                    groupDice.push(
                        diceResults[dieIndex]
                    );
                }
            }


            /*
             * A group with no rule keeps all its dice.
             */
            if (!group.rule) {
                continue;
            }


            /*
             * Sort a copy.
             *
             * The original array order remains the physical dice order,
             * which is useful to the renderer.
             *
             * Primary sort:
             *     die value
             *
             * Secondary sort:
             *     physical die ID
             *
             * The second comparison makes tied results deterministic.
             */
            var sortedDice =
                groupDice.slice().sort(
                    function(a, b) {

                        if (
                            a.value !==
                            b.value
                        ) {

                            return (
                                a.value -
                                b.value
                            );
                        }


                        return (
                            a.diceId -
                            b.diceId
                        );
                    }
                );


            switch (group.rule.type) {

                case 'keep-highest':

                    /*
                     * Start by dropping every die in the group.
                     *
                     * We then explicitly keep exactly N dice.
                     */
                    for (
                        var i = 0;
                        i < groupDice.length;
                        i++
                    ) {

                        groupDice[i].kept =
                            false;
                    }


                    for (
                        var i = sortedDice.length - 1;

                        i >= 0 &&
                        i >=
                            sortedDice.length -
                            group.rule.count;

                        i--
                    ) {

                        sortedDice[i].kept =
                            true;
                    }

                    break;


                case 'keep-lowest':

                    /*
                     * Start by dropping every die.
                     */
                    for (
                        var i = 0;
                        i < groupDice.length;
                        i++
                    ) {

                        groupDice[i].kept =
                            false;
                    }


                    for (
                        var i = 0;

                        i < sortedDice.length &&
                        i < group.rule.count;

                        i++
                    ) {

                        sortedDice[i].kept =
                            true;
                    }

                    break;


                case 'drop-highest':

                    /*
                     * Keep everything initially, then explicitly drop the
                     * requested number of highest physical dice.
                     */
                    for (
                        var i = sortedDice.length - 1;

                        i >= 0 &&
                        i >=
                            sortedDice.length -
                            group.rule.count;

                        i--
                    ) {

                        sortedDice[i].kept =
                            false;
                    }

                    break;


                case 'drop-lowest':

                    /*
                     * Keep everything initially, then explicitly drop the
                     * requested number of lowest physical dice.
                     */
                    for (
                        var i = 0;

                        i < sortedDice.length &&
                        i < group.rule.count;

                        i++
                    ) {

                        sortedDice[i].kept =
                            false;
                    }

                    break;
            }
        }


        return diceResults;
    }


    /**
     * Applies visual changes to dropped dice (those with kept === false).
     * Changes both the die body colour and the label colour to the dropped variants.
     *
     * @param {Object[]} diceResults - Array of rich result objects.
     * @param {THREE.Mesh[]} dices - Array of Three.js dice meshes.
     */
    function apply_dropped_visuals(diceResults, dices) {
        // Build a map for quick lookup by diceId
        var resultMap = {};
        for (var i = 0; i < diceResults.length; i++) {
            resultMap[diceResults[i].diceId] = diceResults[i];
        }

        var droppedCount = 0;
        for (var i = 0; i < dices.length; i++) {
            var dice = dices[i];
            var result = resultMap[dice.dice_id];
            if (!result) continue;

            // Only change if not kept
            if (!result.kept) {
                droppedCount++;
                console.log('Dice Roll: Dropping die', dice.dice_id, 'type', dice.dice_type, 'value', result.value);
                var type = dice.dice_type;
                var geometry = dice.geometry; // keep existing geometry
                var size = vars.scale / 2;
                var margin;
                var face_labels;
                var materialOptions = $t.copyto(vars.material_options, { color: 0xffffff });
                var bodyColor = vars.dropped_dice_color;
                var labelColor = vars.dropped_dice_label_color;

                var materials;
                if (type === 'd4') {
                    // Use the stored variant (or default 0)
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

                // Replace the material
                dice.material = new THREE.MeshFaceMaterial(materials);
                // Mark that we've applied dropped visuals (so we don't re-apply unnecessarily)
                dice.dropped_visuals_applied = true;
            }
        }
        console.log('Dice Roll: Dropped', droppedCount, 'dice.');
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
     *
     * @param {THREE.Mesh} dice
     * @param {number} value
     * @param {number} res
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