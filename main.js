"use strict";

/** @brief 3d dice roller web app
 *  @author Sarah Rosanna Busch
 *  @date 10 Aug 2023
 *  @version 0.1
 */


 var main = (function() {
    var that = {}; 
    var elem = {}; 
    var vars = {
        numpadShowing: false,
        lastVal: '',
        userTyping: false
    }
    var box = null;

    that.init = function() {
        elem.container = $t.id('diceRoller');
        elem.result = $t.id('result');
        elem.textInput = $t.id('textInput'); 
        elem.instructions = $t.id('instructions');
        elem.center_div = $t.id('center_div');
        elem.diceLimit = $t.id('diceLimit');

        box = new DICE.dice_box(elem.container);
        box.bind_swipe(elem.center_div, before_roll, after_roll);

        $t.bind(elem.textInput, 'change', function(ev) { //shows instructions
            show_instructions(); 
        }); 
        $t.bind(elem.textInput, 'input', function(ev) { 
            let size = elem.textInput.value.length;
            elem.textInput.size = size > 0 ? size : 1;
            box.setDice(textInput.value);
        });
        $t.bind(elem.textInput, 'focus', function(ev) {
            elem.diceLimit.style.display = 'none';
            //ev.preventDefault();
        });
        $t.bind(elem.textInput, 'blur', function(ev) {
            //necessary to do this here for iOS compatibility
            //because they put cursor back to zero on blur
            vars.caretPos = elem.textInput.selectionStart;
            vars.selectionEnd = elem.textInput.selectionEnd;
        });
        $t.bind(elem.textInput, 'mouseup', function(ev) {
            ev.preventDefault();
        });

        box.setDice(textInput.value);
        //box.start_throw(); //start by throwing all the dice on the table

        show_instructions(true);

        const builder = new DieBuilder({
        popup: {
            enabled: true,
            targetInput: '#textInput',
            width: '85vw',
            closeOnOutsideClick: true,
            closeOnEscape: true
        },
        theme: {
            mode: 'dark',
            colors: {
                primary: '#ff6b6b',
                success: '#2ecc71'
            }
        },
        callbacks: {
            onAccept: (notation) => {
                console.log('Accepted:', notation);
                // Your app logic
            },
            onError: (err) => {
                alert('Error: ' + err.message);
            }
            },
            // Custom validator (optional)
            validator: (notation) => {
            if (notation.includes('d1')) return 'd1 is not allowed';
            return true;
        }
    });

    builder.attachTo('#textInput');
    }

    that.setInput = function() {
        let inputVal = elem.textInput.value;
        //check for d100 and add tens place die
        if(inputVal.includes('d100')) {
            let dIdx = inputVal.indexOf('d100');
            let numD100 = '';
            for(let i = dIdx - 1; i >= 0; i--) {
                let digit = inputVal[i];
                if(!isNaN(digit)) {
                    numD100 = digit + numD100;
                } else {
                    break;
                }                
            }
            if(numD100 === '') numD100 = '1';
            //console.log('num d100s: ' + numD100);
            for(let i = 0; i < numD100; i++) {
                //inputVal += '+d9';
            }
        }
        //check for too many dice
        let d = DICE.parse_notation(inputVal);
        let numDice = d.set.length;
        box.setDice(inputVal);
        show_instructions(true);
    }

    that.clearInput = function() {
        elem.textInput.value = '';
    }

    function _handleInput() {
        let text = elem.textInput.value;
        let selectedText = (vars.caretPos === vars.selectionEnd) ? false : true;
        if(vars.lastVal === "del") {
            if(selectedText) {
                deleteText();
            } else {
                text = text.substring(0, vars.caretPos) + text.substring(vars.caretPos+1, text.length);
            }
        } else if(vars.lastVal === "bksp") {
            if(selectedText) {
                deleteText();
            } else {
                text = text.substring(0, vars.caretPos-1) + text.substring(vars.caretPos, text.length);
                vars.caretPos--;
            }
        } else {
            deleteText();
            text = text.substring(0, vars.caretPos) + vars.lastVal + text.substring(vars.caretPos, text.length);
            vars.caretPos++;
        }
        elem.textInput.value = text;
        setTimeout(() => {
            elem.textInput.setSelectionRange(vars.caretPos, vars.caretPos);
        }, 1);

        function deleteText() {
            text = text.substring(0, vars.caretPos) + text.substring(vars.selectionEnd, text.length);
            setTimeout(() => {
                elem.textInput.setSelectionRange(vars.caretPos, vars.caretPos);
            }, 1);
        }
    }

    // show 'Roll Dice' swipe instructions
    // param show = bool
    function show_instructions(show) {
        if(show) {
            elem.instructions.style.display = 'inline-block';
        } else {
            elem.instructions.style.display = 'none';
        }
    }

    // @brief callback function called when dice roll event starts
    // @param notation indicates which dice are going to roll
    // @return null for random result || array of desired results
    function before_roll(notation) {
        //console.log('before_roll notation: ' + JSON.stringify(notation));
        show_instructions(false);
        elem.result.innerHTML = '';       
        return null;
    }

    // @brief callback function called once dice stop moving
    // @param notation now includes results
    function after_roll(notation) {
        //console.log('after_roll notation: ' + JSON.stringify(notation));
        if(notation.result[0] < 0) {
            elem.result.innerHTML = "Oops, your dice fell off the table. <br> Refresh and roll again."
        } else {
            elem.result.innerHTML = notation.resultString;
        }
    }

    return that;
}());
