'use strict';

const ModelsMasterView = require('../../../app/scripts/modules/ui/ModelsMasterView.js');

describe('ModelsMasterView', function () {
    var fixtures = document.getElementById('fixtures');
    var calls;
    var view;

    /**
     * Builds one row of the models list.
     * @param {string} id
     * @param {string} name
     * @param {boolean} internal
     * @returns {Object}
     */
    function createModel(id, name, internal) {
        return {
            id: id,
            name: name,
            internal: internal,
            type: 'sap.ui.model.json.JSONModel',
            kind: 'JSON',
            owner: 'container-app',
            ownerKind: 'Component',
            ownerNavigationId: '__xmlview0',
            entries: 1
        };
    }

    /**
     * Returns the ids of the rows currently in the grid.
     * @returns {Array}
     */
    function listedIds() {
        return view.oDataGrid.rootNode().children.map(function (oNode) {
            return oNode._data.id;
        });
    }

    beforeEach(function () {
        fixtures.innerHTML = '<div id="models-tab-master"></div>';
        calls = {refresh: [], navigate: [], select: []};

        view = new ModelsMasterView('models-tab-master', {
            onRefreshButtonClicked: function (sSelectedId) {
                calls.refresh.push(sSelectedId);
            },
            onSelectItem: function (sId) {
                calls.select.push(sId);
            },
            onNavigateToOwner: function (sId) {
                calls.navigate.push(sId);
            }
        });

        view.setData({
            isSupported: true,
            models: [createModel('m-0', 'cart', false), createModel('m-1', '$componentState', true)]
        });
    });

    afterEach(function () {
        fixtures.innerHTML = '';
    });

    it('should hide internal models and report how many are held back', function () {
        listedIds().should.deep.equal(['m-0']);
        fixtures.querySelector('#modelsInternalCount').textContent.should.equal('(1)');
    });

    it('should list internal models once "Show internal" is checked', function () {
        var checkbox = fixtures.querySelector('#modelsInternal');

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));

        listedIds().should.deep.equal(['m-0', 'm-1']);
    });

    it('should filter the rows on search input when "Filter results" is checked', function () {
        var search = fixtures.querySelector('#modelsSearch');

        view.setData({
            isSupported: true,
            models: [createModel('m-0', 'cart', false), createModel('m-2', 'i18n', false)]
        });
        fixtures.querySelector('#modelsCheckbox').checked = true;
        search.value = 'I18N';
        search.dispatchEvent(new Event('input'));

        listedIds().should.deep.equal(['m-2']);
        fixtures.querySelector('#modelsResults').textContent.should.equal('(1)');
    });

    it('should reveal the owner when its OWNER ID cell is clicked', function () {
        var row = document.createElement('tr');
        var cell = document.createElement('td');

        cell.className = 'owner-column';
        row._dataGridNode = {_data: createModel('m-0', 'cart', false)};
        row.appendChild(cell);

        view._onDataGridClick({target: cell});

        calls.navigate.should.deep.equal(['__xmlview0']);
    });

    it('should rescan from a native button and clear the list', function () {
        var button = fixtures.querySelector('#modelsRefresh');

        button.tagName.should.equal('BUTTON');
        button.click();

        calls.refresh.should.deep.equal([undefined]);
        view.getData().should.deep.equal([]);
    });

    it('should hand the selected model to the rescan', function () {
        view.selectModel('m-0');
        fixtures.querySelector('#modelsRefresh').click();

        calls.refresh.should.deep.equal(['m-0']);
    });

    it('should select a model by id and ask for its details', function () {
        view.selectModel('m-0');
        view.selectModel('not-listed');

        view.oDataGrid.selectedNode._data.id.should.equal('m-0');
        calls.select.should.deep.equal(['m-0']);
    });

    it('should show a message when the page cannot be scanned', function () {
        view.setData({isSupported: false, models: []});

        fixtures.querySelector('#modelsMessage').style.display.should.equal('block');
        fixtures.querySelector('#modelsContent').style.display.should.equal('none');
    });
});
