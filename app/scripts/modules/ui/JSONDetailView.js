/* globals ResizeObserver */

'use strict';

// Anchored at both ends so model data that looks similar cannot pass for a marker.
const rMarker = /"(…[^"]*) #([a-z0-9]+:\d+)"/;

/**
 * Read only JSON viewer backed by the ace editor. The editor id is derived from the
 * container, so several instances can live on the same page.
 * @param {string} containerId - id of the DOM container
 * @param {Object} options - {emptyMessage: string, ariaLabel: string,
 *                           onExpand: function(markerId, expandWholeBranch)}
 * @constructor
 */
function JSONDetailView(containerId, options) {
    this.sEmptyMessage = options.emptyMessage;
    this.fnExpand = options.onExpand;
    // Row of a rendered marker -> the id it is expanded by.
    this.mRowIds = {};

    this.oContainer = document.getElementById(containerId);
    this.oEditorDOM = document.createElement('div');
    this.oEditorDOM.id = containerId + '-editor';
    this.oEditorDOM.classList.add('jsonEditor');
    // ace renders a focusable textarea, which would otherwise reach a screen reader
    // with no name of its own.
    this.oEditorDOM.setAttribute('role', 'group');
    this.oEditorDOM.setAttribute('aria-label', options.ariaLabel);
    this.oEditorDOM.classList.toggle('hidden', true);
    this.oContainer.appendChild(this.oEditorDOM);

    this.oEditorAltDOM = document.createElement('div');
    this.oEditorAltDOM.classList.add('editorAlt');
    this.oEditorAltMessageDOM = document.createElement('div');
    this.oEditorAltMessageDOM.innerText = this.sEmptyMessage;
    this.oEditorAltDOM.appendChild(this.oEditorAltMessageDOM);
    this.oContainer.appendChild(this.oEditorAltDOM);

    this.oEditor = ace.edit(this.oEditorDOM.id);
    this.oEditor.getSession().setUseWrapMode(true);
    this.oEditor.setReadOnly(true);
    this._setTheme();

    const oResizeObserver = new ResizeObserver(function () {
        this.oEditor.resize();
    }.bind(this));
    oResizeObserver.observe(this.oEditorDOM);

    this.oEditor.on('click', function (oEvent) {
        this._expandRow(oEvent.getDocumentPosition().row, oEvent.domEvent.altKey);
    }.bind(this));

    // ponytail: the marker is editor text, not a button, so Enter on its line is the
    // keyboard path. A disclosure widget needs a JSON viewer that is not a text editor.
    this._addExpandCommand('expandMarker', 'Return', false);
    this._addExpandCommand('expandMarkerBranch', 'Alt-Return', true);
}

/**
 * Binds one key to expanding the marker on the cursor's line.
 * @param {string} sName - ace command name
 * @param {string} sKey - ace key binding
 * @param {boolean} bDeep - whether the key opens the whole branch
 * @private
 */
JSONDetailView.prototype._addExpandCommand = function (sName, sKey, bDeep) {
    this.oEditor.commands.addCommand({
        name: sName,
        bindKey: {win: sKey, mac: sKey},
        // Without this ace drops the command in a read only editor.
        readOnly: true,
        exec: function () {
            this._expandRow(this.oEditor.getCursorPosition().row, bDeep);
        }.bind(this)
    });
};

/**
 * Asks for the contents of the marker on one line, if that line carries one.
 * @param {number} iRow
 * @param {boolean} bDeep - whether to open the whole branch
 * @private
 */
JSONDetailView.prototype._expandRow = function (iRow, bDeep) {
    const sId = this.mRowIds[iRow];

    if (sId && this.fnExpand) {
        this.fnExpand(sId, bDeep);
    }
};

/**
 * Replaces the first string ending in sSuffix, anywhere below vNode.
 * @param {*} vNode
 * @param {string} sSuffix
 * @param {*} vValue
 * @returns {boolean} whether a marker was found
 * @private
 */
function _replaceMarker(vNode, sSuffix, vValue) {
    if (!vNode || typeof vNode !== 'object') {
        return false;
    }

    return Object.keys(vNode).some(function (sKey) {
        const vChild = vNode[sKey];

        if (typeof vChild === 'string' && vChild.endsWith(sSuffix)) {
            vNode[sKey] = vValue;
            return true;
        }

        return _replaceMarker(vChild, sSuffix, vValue);
    });
}

/**
 * Replaces the marker with the given id by the value the page sent back for it.
 * @param {string} sId - id of the marker
 * @param {*} vValue - the contents below it, or undefined when the page could not read them
 * @returns {boolean} whether this view was showing that marker
 */
JSONDetailView.prototype.applyExpansion = function (sId, vValue) {
    const sSuffix = '#' + sId;
    const vReplacement = vValue === undefined ?
        '[gone: select the model again to read this]' :
        vValue;

    if (!_replaceMarker(this.vData, sSuffix, vReplacement)) {
        return false;
    }

    // Expanding in place should not throw the reader back to the top of the model.
    const iScrollTop = this.oEditor.session.getScrollTop();
    this._render();
    this.oEditor.session.setScrollTop(iScrollTop);

    return true;
};

/**
 * Shows a value as formatted JSON, or a message when there is nothing to show.
 * @param {*} vData - any JSON serializable value
 * @param {string} [sAltMessage] - message shown when vData is undefined
 */
JSONDetailView.prototype.update = function (vData, sAltMessage) {
    const bHasData = vData !== undefined && vData !== null;

    this.oEditorDOM.classList.toggle('hidden', !bHasData);
    this.oEditorAltDOM.classList.toggle('hidden', bHasData);

    this.vData = vData;

    if (!bHasData) {
        this.mRowIds = {};
        this.oEditorAltMessageDOM.innerText = sAltMessage || this.sEmptyMessage;
        return;
    }

    this._render();
};

/**
 * Writes the current data into the editor, hiding the ids of the truncation markers and
 * remembering which row each one landed on.
 * @private
 */
JSONDetailView.prototype._render = function () {
    const bIsText = typeof this.vData === 'string';
    let sContent = bIsText ? this.vData : JSON.stringify(this.vData, null, 2);

    this.mRowIds = {};

    if (!bIsText) {
        sContent = sContent.split('\n').map(function (sLine, iRow) {
            // The id is machinery, not something the reader needs to see.
            return sLine.replace(rMarker, function (sMatch, sText, sId) {
                this.mRowIds[iRow] = sId;
                return '"' + sText + '"';
            }.bind(this));
        }.bind(this)).join('\n');
    }

    // An XMLModel arrives already serialized, so do not highlight it as JSON.
    this.oEditor.session.setMode(bIsText ? 'ace/mode/text' : 'ace/mode/json');
    this.oEditor.setValue(sContent, 0);
    this.oEditor.clearSelection();
};

/**
 * Clears the editor and shows the empty message again.
 */
JSONDetailView.prototype.clear = function () {
    this.update(undefined);
};

/**
 * Applies the current devtools theme.
 * @private
 */
JSONDetailView.prototype._setTheme = function () {
    var bDarkMode = chrome.devtools.panels.themeName === 'dark';

    this.oEditor.setTheme(bDarkMode ? 'ace/theme/vibrant_ink' : 'ace/theme/chrome');
};

module.exports = JSONDetailView;
