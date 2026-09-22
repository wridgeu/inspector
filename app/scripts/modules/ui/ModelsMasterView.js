/* globals ResizeObserver */

'use strict';

const DataGrid = require('./datagrid/DataGrid.js');
const UIUtils = require('./datagrid/UIUtils.js');

/**
 * Creates a column definition.
 * @param {string} id - property of the row
 * @param {string} title - column header
 * @param {number} weight - relative width
 * @param {Object} [options] - {disclosure: boolean, comparator: Function}
 * @returns {Object}
 */
function createColumn(id, title, weight, options) {
    const comparator = (options && options.comparator) || DataGrid.SortableDataGrid.StringComparator;

    return {
        id: id,
        title: title,
        sortable: true,
        align: undefined,
        nonSelectable: false,
        weight: weight,
        visible: true,
        allowInSortByEvenWhenHidden: false,
        disclosure: options && options.disclosure,
        /**
         * Sorts rows by this column.
         * @param {Object} a
         * @param {Object} b
         */
        sortingFunction: function (a, b) {
            return comparator(id, a, b);
        }
    };
}

const COLUMNS = [
    createColumn('name', 'NAME', 20, {disclosure: true}),
    createColumn('kind', 'KIND', 12),
    createColumn('type', 'CLASS', 28),
    createColumn('ownerKind', 'SET ON', 12),
    createColumn('owner', 'OWNER ID', 20),
    createColumn('entries', 'ENTRIES', 8, {comparator: DataGrid.SortableDataGrid.NumericComparator})
];

/**
 * Master list of every model instance found on the inspected page.
 * @param {string} domId - id of the DOM container
 * @param {Object} options - {onSelectItem, onNavigateToOwner, onRefreshButtonClicked}
 * @constructor
 */
function ModelsMasterView(domId, options) {
    this.oContainerDOM = document.getElementById(domId);
    this.sNotSupportedMessage = '<h1>No OpenUI5/SAPUI5 models could be read from this page</h1>';
    this._data = [];

    /**
     * Fired when a model row is selected.
     * @param {string} sModelId
     */
    this.onSelectItem = (options && options.onSelectItem) || function (sModelId) {};

    /**
     * Fired when the refresh button is clicked.
     * @param {string} [sSelectedModelId] - the model selected before the rescan
     */
    this.onRefreshButtonClicked = (options && options.onRefreshButtonClicked) || function () {};

    /**
     * Fired when the owner of a model should be revealed in the Control Inspector.
     * @param {string} sNavigationId
     */
    this.onNavigateToOwner = (options && options.onNavigateToOwner) || function (sNavigationId) {};

    this.oContainerDOM.appendChild(this._createContent());
    this.oContainerDOM.appendChild(this._createMessage());

    this._setReferences();
    this._createHandlers();
}

/**
 * Builds the content: the filter bar, with the refresh button at its end, and the data grid.
 * @returns {HTMLElement}
 * @private
 */
ModelsMasterView.prototype._createContent = function () {
    const oContainer = document.createElement('div');
    oContainer.setAttribute('id', 'modelsContent');

    oContainer.insertAdjacentHTML('beforeend', this._createFilter());
    oContainer.querySelector('filter').appendChild(this._createRefreshButton());

    this.oDataGrid = this._createDataGrid();
    oContainer.appendChild(this.oDataGrid.element);

    return oContainer;
};

/**
 * Create the HTML needed for filtering.
 * @returns {string}
 * @private
 */
ModelsMasterView.prototype._createFilter = function () {
    return '<filter>' +
        '<start>' +
        '<input id="modelsSearch" type="search" placeholder="Search name, class or owner" aria-label="Search models" search/>' +
        '<label for="modelsCheckbox"><input id="modelsCheckbox" type="checkbox" filter />Filter results</label>' +
        '<results id="modelsResults"></results>' +
        '<label for="modelsInternal"><input id="modelsInternal" type="checkbox" />Show internal</label>' +
        '<results id="modelsInternalCount"></results>' +
        '</start>' +
        '</filter>';
};

/**
 * Placeholder for the "nothing to show" message.
 * @returns {HTMLElement}
 * @private
 */
ModelsMasterView.prototype._createMessage = function () {
    const oContainer = document.createElement('div');
    oContainer.setAttribute('id', 'modelsMessage');
    oContainer.style.display = 'none';

    return oContainer;
};

/**
 * Creates the refresh button.
 * @returns {HTMLElement}
 * @private
 */
ModelsMasterView.prototype._createRefreshButton = function () {
    const oButton = document.createElement('button');
    const oIcon = UIUtils.Icon.create('', 'toolbar-glyph');

    oIcon.setIconType('largeicon-refresh');
    oButton.id = 'modelsRefresh';
    oButton.type = 'button';
    oButton.title = 'Rescan the page for models';
    oButton.setAttribute('aria-label', oButton.title);
    oButton.appendChild(oIcon);

    return oButton;
};

/**
 * Caches DOM references.
 * @private
 */
ModelsMasterView.prototype._setReferences = function () {
    this._oContentContainer = this.oContainerDOM.querySelector('#modelsContent');
    this._oMessageContainer = this.oContainerDOM.querySelector('#modelsMessage');
    this._oFilterContainer = this.oContainerDOM.querySelector('#modelsSearch');
    this._oFilterCheckBox = this.oContainerDOM.querySelector('#modelsCheckbox');
    this._oFilterResults = this.oContainerDOM.querySelector('#modelsResults');
    this._oInternalCheckBox = this.oContainerDOM.querySelector('#modelsInternal');
    this._oInternalCount = this.oContainerDOM.querySelector('#modelsInternalCount');
    this._oRefreshButton = this.oContainerDOM.querySelector('#modelsRefresh');
};

/**
 * Wires up search, filter and refresh.
 * @private
 */
ModelsMasterView.prototype._createHandlers = function () {
    // 'input' also covers paste and the native clear button of <input type="search">.
    this._oFilterContainer.oninput = this._onSearchInput.bind(this);
    this._oFilterCheckBox.onchange = this._onOptionsChange.bind(this);
    this._oInternalCheckBox.onchange = this._onOptionsChange.bind(this);
    this._oRefreshButton.onclick = this._onRefresh.bind(this);
    this.oDataGrid.element.onclick = this._onDataGridClick.bind(this);
};

/**
 * Reveals the owner of a model when its OWNER ID cell is clicked.
 * @param {Object} event - click event
 * @private
 */
ModelsMasterView.prototype._onDataGridClick = function (event) {
    let oTarget = event.target;

    while (oTarget && oTarget !== this.oDataGrid.element && oTarget.tagName !== 'TD') {
        oTarget = oTarget.parentElement;
    }

    if (!oTarget || !oTarget.classList.contains('owner-column')) {
        return;
    }

    const oNode = oTarget.parentElement && oTarget.parentElement._dataGridNode;

    if (oNode && oNode._data.ownerNavigationId) {
        this.onNavigateToOwner(oNode._data.ownerNavigationId);
    }
};

/**
 * Returns true when a row matches the search term.
 * @param {Object} oModel - row
 * @param {string} sSearch - lower cased search term
 * @returns {boolean}
 * @private
 */
ModelsMasterView.prototype._matches = function (oModel, sSearch) {
    return [oModel.name, oModel.type, oModel.owner, oModel.kind].some(function (sValue) {
        return sValue.toLocaleLowerCase().indexOf(sSearch) !== -1;
    });
};

/**
 * Highlights matching rows and updates the result count.
 * @param {Object} event - input event
 * @private
 */
ModelsMasterView.prototype._onSearchInput = function (event) {
    this._highlightMatches(event.target.value.toLocaleLowerCase());

    if (this._oFilterCheckBox.checked) {
        this._filterResults();
    }
};

/**
 * Highlights the rows matching the search term and updates the result count.
 * Only the rendered viewport slice carries DOM nodes, so this also runs on scroll.
 * @param {string} sSearch - lower cased search term
 * @private
 */
ModelsMasterView.prototype._highlightMatches = function (sSearch) {
    this.oDataGrid._visibleNodes.forEach(function (oNode) {
        const bMatch = sSearch !== '' && this._matches(oNode._data, sSearch);
        oNode._element.classList.toggle('matching', bMatch);
    }, this);

    // Count only what the grid can show, otherwise the number contradicts the rows.
    const iCount = sSearch === '' ? 0 : this.getData().filter(function (oModel) {
        return this._isListed(oModel) && this._matches(oModel, sSearch);
    }, this).length;

    this._oFilterResults.textContent = '(' + iCount + ')';
};

/**
 * Whether a row is shown at all, which the "Show internal" checkbox decides.
 * @param {Object} oModel - row
 * @returns {boolean}
 * @private
 */
ModelsMasterView.prototype._isListed = function (oModel) {
    return !oModel.internal || this._oInternalCheckBox.checked;
};

/**
 * Re-applies the highlight after the grid scrolled a new slice into the DOM.
 * @private
 */
ModelsMasterView.prototype._onViewPortCalculated = function () {
    this._highlightMatches(this._oFilterContainer.value.toLocaleLowerCase());
};

/**
 * Re-applies both checkboxes. Shared by them, so it reads the filter state rather than
 * the checkbox that happened to change.
 * @private
 */
ModelsMasterView.prototype._onOptionsChange = function () {
    if (this._oFilterCheckBox.checked) {
        this.oContainerDOM.setAttribute('show-filtered-elements', true);
    } else {
        this.oContainerDOM.removeAttribute('show-filtered-elements');
    }

    // The grid rebuild is what re-applies the highlight: it dispatches ViewportCalculated
    // on the next frame, once the new rows actually carry DOM nodes.
    this._filterResults();
};

/**
 * Rebuilds the grid honouring the current filter.
 * @private
 */
ModelsMasterView.prototype._filterResults = function () {
    const sSearch = this._oFilterContainer.value.toLocaleLowerCase();
    const bFilter = this._oFilterCheckBox.checked && sSearch !== '';
    // Rebuilding the grid detaches the selection.
    const sSelectedId = this._sSelectedItem;

    this.oDataGrid.rootNode().removeChildren();

    this.getData().forEach(function (oModel) {
        if (this._isListed(oModel) && (!bFilter || this._matches(oModel, sSearch))) {
            const oNode = new DataGrid.SortableDataGridNode(oModel);
            this.oDataGrid.insertChild(oNode);

            if (oModel.id === sSelectedId) {
                // Restoring the selection must not look like the user picking a row,
                // or every keystroke would refetch the model's data.
                oNode.select(true);
            }
        }
    }, this);

    this.sortHandler();
};

/**
 * Clears the grid and asks the page for a fresh scan. Filter, search and the selected
 * model carry over, so a refresh updates the view rather than resetting it.
 * @private
 */
ModelsMasterView.prototype._onRefresh = function () {
    const sSelectedId = this._sSelectedItem;

    this.oDataGrid.rootNode().removeChildren();
    this._data = [];
    this._sSelectedItem = undefined;
    this.onRefreshButtonClicked(sSelectedId);
};

/**
 * Selects a row as if it had been clicked, so its details are read again.
 * @param {string} [sModelId] - no-op when the row is not listed
 */
ModelsMasterView.prototype.selectModel = function (sModelId) {
    const oNode = this.oDataGrid.rootNode().children.find(function (oChild) {
        return oChild._data.id === sModelId;
    });

    if (oNode) {
        oNode.reveal();
        oNode.select();
    }
};

/**
 * Returns the current rows.
 * @returns {Array}
 */
ModelsMasterView.prototype.getData = function () {
    return this._data;
};

/**
 * Renders the scan result.
 * @param {Object} data - {isSupported: boolean, models: Array}
 * @returns {ModelsMasterView}
 */
ModelsMasterView.prototype.setData = function (data) {
    const aModels = (data && data.models) || [];

    // Every caller empties the detail views alongside this, and select() early-returns on
    // an already selected node, so a kept selection could never be clicked back to life.
    if (this.oDataGrid.selectedNode) {
        this.oDataGrid.selectedNode.deselect();
    }
    this._sSelectedItem = undefined;

    if (data && data.isSupported === false) {
        this._oMessageContainer.innerHTML = this.sNotSupportedMessage;
        this._oContentContainer.style.display = 'none';
        this._oMessageContainer.style.display = 'block';
        return this;
    }

    this._oMessageContainer.style.display = 'none';
    this._oContentContainer.style.display = 'flex';

    this._oInternalCount.textContent = '(' + aModels.filter(function (oModel) {
        return oModel.internal;
    }).length + ')';

    if (JSON.stringify(this._data) === JSON.stringify(aModels)) {
        return this;
    }

    this._data = aModels;
    this._filterResults();

    return this;
};

/**
 * Creates the data grid.
 * @returns {Object}
 * @private
 */
ModelsMasterView.prototype._createDataGrid = function () {
    const oDataGrid = new DataGrid.SortableDataGrid({
        displayName: 'models',
        columns: COLUMNS
    });

    oDataGrid.addEventListener(DataGrid.Events.SortingChanged, this.sortHandler, this);
    oDataGrid.addEventListener(DataGrid.Events.SelectedNode, this.selectHandler, this);
    oDataGrid.addEventListener(DataGrid.Events.ViewportCalculated, this._onViewPortCalculated, this);

    const oResizeObserver = new ResizeObserver(function () {
        oDataGrid.onResize();
    });
    oResizeObserver.observe(oDataGrid.element);

    return oDataGrid;
};

/**
 * Sorts the grid by the clicked column.
 */
ModelsMasterView.prototype.sortHandler = function () {
    const sColumnId = this.oDataGrid.sortColumnId();
    const oColumnConfig = COLUMNS.find(function (oColumn) {
        return oColumn.id === sColumnId;
    });

    if (!oColumnConfig || !oColumnConfig.sortingFunction) {
        return;
    }

    this.oDataGrid.sortNodes(oColumnConfig.sortingFunction, !this.oDataGrid.isSortOrderAscending());
};

/**
 * Notifies about the selected model.
 * @param {Object} oEvent
 */
ModelsMasterView.prototype.selectHandler = function (oEvent) {
    this._sSelectedItem = oEvent.data._data.id;
    this.onSelectItem(this._sSelectedItem);
};

module.exports = ModelsMasterView;
