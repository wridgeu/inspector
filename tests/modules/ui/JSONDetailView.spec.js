'use strict';

const JSONDetailView = require('../../../app/scripts/modules/ui/JSONDetailView.js');

describe('JSONDetailView', function () {
    var fixtures = document.getElementById('fixtures');
    var marker = '… (click to expand) #abc123:0';
    var originalAce = window.ace;
    var originalDevtools = window.chrome.devtools;
    var editor;
    var expanded;
    var view;

    /**
     * Minimal stand-in for the ace editor, which karma does not load.
     * @returns {Object}
     */
    function createEditorStub() {
        var stub = {
            value: '',
            row: 0,
            handlers: {},
            commands: {
                list: {},
                addCommand: function (command) {
                    this.list[command.name] = command;
                }
            },
            session: {
                setMode: function () {},
                getScrollTop: function () {
                    return 0;
                },
                setScrollTop: function () {}
            },
            getSession: function () {
                return {setUseWrapMode: function () {}, setUseWorker: function () {}};
            },
            setReadOnly: function () {},
            setTheme: function () {},
            resize: function () {},
            clearSelection: function () {},
            on: function (name, handler) {
                stub.handlers[name] = handler;
            },
            setValue: function (value) {
                stub.value = value;
            },
            getCursorPosition: function () {
                return {row: stub.row};
            }
        };

        return stub;
    }

    /**
     * Returns the editor row a text first appears on.
     * @param {string} text
     * @returns {number}
     */
    function rowOf(text) {
        return editor.value.split('\n').findIndex(function (line) {
            return line.indexOf(text) !== -1;
        });
    }

    /**
     * Simulates a click on one editor row.
     * @param {number} row
     * @param {boolean} altKey
     */
    function clickRow(row, altKey) {
        editor.handlers.click({
            getDocumentPosition: function () {
                return {row: row};
            },
            domEvent: {altKey: altKey}
        });
    }

    beforeEach(function () {
        fixtures.innerHTML = '<div id="json-view"></div>';
        editor = createEditorStub();
        expanded = [];
        window.ace = {
            edit: function () {
                return editor;
            }
        };
        window.chrome.devtools = {panels: {themeName: 'default'}};

        view = new JSONDetailView('json-view', {
            emptyMessage: 'Nothing selected',
            ariaLabel: 'Test data',
            onExpand: function (id, deep) {
                expanded.push({id: id, deep: deep});
            }
        });
    });

    afterEach(function () {
        window.ace = originalAce;
        window.chrome.devtools = originalDevtools;
        fixtures.innerHTML = '';
    });

    it('should show the empty message until data arrives', function () {
        fixtures.querySelector('.editorAlt').textContent.should.equal('Nothing selected');
        fixtures.querySelector('.jsonEditor').classList.contains('hidden').should.equal(true);
    });

    it('should show the given message when the data is undefined', function () {
        view.update(undefined, 'Gone');

        fixtures.querySelector('.editorAlt').textContent.should.equal('Gone');
    });

    it('should hide the marker id but keep the marker text', function () {
        view.update({a: {b: marker}});

        editor.value.should.contain('… (click to expand)');
        editor.value.should.not.contain('abc123');
    });

    it('should request the next levels when a marker row is clicked', function () {
        view.update({a: {b: marker}});
        clickRow(rowOf('click to expand'), false);

        expanded.should.deep.equal([{id: 'abc123:0', deep: false}]);
    });

    it('should request the whole branch on alt-click', function () {
        view.update({a: {b: marker}});
        clickRow(rowOf('click to expand'), true);

        expanded.should.deep.equal([{id: 'abc123:0', deep: true}]);
    });

    it('should expand the marker on the cursor row with Enter and Alt-Enter', function () {
        view.update({a: {b: marker}});
        editor.row = rowOf('click to expand');

        editor.commands.list.expandMarker.exec();
        editor.commands.list.expandMarkerBranch.exec();

        expanded.should.deep.equal([{id: 'abc123:0', deep: false}, {id: 'abc123:0', deep: true}]);
    });

    it('should not treat model data that only contains a marker as one', function () {
        view.update({a: 'see ' + marker});
        clickRow(rowOf('click to expand'), false);

        expanded.should.deep.equal([]);
        editor.value.should.contain('abc123');
    });

    it('should replace the marker with the expanded value', function () {
        view.update({a: {b: marker}});

        view.applyExpansion('abc123:0', {c: 1}).should.equal(true);
        editor.value.should.not.contain('click to expand');
        editor.value.should.contain('"c": 1');
    });

    it('should report a marker it is not showing', function () {
        view.update({a: {b: marker}});

        view.applyExpansion('other:1', {c: 1}).should.equal(false);
    });
});
