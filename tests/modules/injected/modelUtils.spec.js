'use strict';

var modelUtils = require('../../../app/scripts/modules/injected/modelUtils.js');

/**
 * Minimal stand-in for a UI5 model.
 * @param {string} className - the class the metadata reports
 * @param {*} data - what getData() returns
 * @param {Object} [extra] - extra properties mixed into the model
 * @returns {Object}
 */
function createModel(className, data, extra) {
    var model = {
        getMetadata: function () {
            return {
                getName: function () {
                    return className;
                }
            };
        },
        getData: function () {
            return data;
        },
        getDefaultBindingMode: function () {
            return 'TwoWay';
        },
        iSizeLimit: 100
    };

    return Object.assign(model, extra || {});
}

/**
 * Builds a chain of nested objects with a leaf at the bottom.
 * @param {number} levels - how deep the chain goes
 * @returns {Object}
 */
function createChain(levels) {
    var root = {};
    var cursor = root;

    for (var i = 0; i < levels; i++) {
        cursor.child = {};
        cursor = cursor.child;
    }
    cursor.leaf = 'bottom';

    return root;
}

/**
 * Follows the child chain of a cloned value down to whatever it ends in.
 * @param {*} value
 * @returns {Object} {end: *, levels: number}
 */
function followChain(value) {
    var levels = 0;

    while (value && typeof value === 'object' && value.child) {
        value = value.child;
        levels++;
    }

    return {end: value, levels: levels};
}
/**
 * Minimal stand-in for a Component or an Element.
 * @param {string} id
 * @param {string} className
 * @param {Object} models - the own models map
 * @param {Object} [propagatedModels] - models inherited from the Core
 * @returns {Object}
 */
function createOwner(id, className, models, propagatedModels) {
    return {
        oModels: models,
        oPropagatedProperties: {oModels: propagatedModels || {}},
        getRootControl: function () {
            return {
                getId: function () {
                    return id + '---rootView';
                }
            };
        },
        getId: function () {
            return id;
        },
        // A root control: its parent is a UIArea, not an Element.
        getParent: function () {
            return undefined;
        },
        // No sap.app/type, like a component without a manifest.
        getManifestEntry: function () {
            return undefined;
        },
        getMetadata: function () {
            return {
                getName: function () {
                    return className;
                }
            };
        }
    };
}

/**
 * Installs a fake sap.ui with the given registries for the duration of one test.
 * @param {Object} components
 * @param {Object} elements
 */
function stubSapUi(components, elements) {
    window.sap = {
        ui: {
            require: function (name) {
                if (name === 'sap/ui/core/ComponentRegistry') {
                    return {all: function () { return components; }};
                }
                if (name === 'sap/ui/core/ElementRegistry') {
                    return {all: function () { return elements; }};
                }
                if (name === 'sap/ui/core/Lib') {
                    return {all: function () { return {'sap.m': {}, 'sap.ushell': {}, 'sap.fe.core': {}, 'sap.fe.templates': {}}; }};
                }
                return undefined;
            }
        }
    };
}

describe('modelUtils', function () {
    var originalSap;

    beforeEach(function () {
        originalSap = window.sap;
    });

    afterEach(function () {
        window.sap = originalSap;
    });

    describe('#_clone()', function () {
        it('should copy plain data unchanged', function () {
            var result = modelUtils._clone({a: 1, b: 'two', c: [true, null]});

            result.value.should.deep.equal({a: 1, b: 'two', c: [true, null]});
            result.truncated.should.equal(false);
        });

        it('should replace a cycle with a marker instead of overflowing the stack', function () {
            var cyclic = {name: 'root'};
            cyclic.self = cyclic;

            var result = modelUtils._clone(cyclic);

            result.value.name.should.equal('root');
            result.value.self.should.equal('[circular]');
        });

        it('should keep a repeated - but not cyclic - object as real data', function () {
            var shared = {id: 1};
            var result = modelUtils._clone({first: shared, second: shared});

            result.value.first.should.deep.equal({id: 1});
            result.value.second.should.deep.equal({id: 1});
        });

        it('should replace values that cannot be serialized with tags', function () {
            var result = modelUtils._clone({
                fn: function namedFunction() {},
                node: document.createElement('div'),
                when: new Date(0),
                control: {
                    isA: function (type) { return type === 'sap.ui.base.ManagedObject'; },
                    getId: function () { return 'button1'; },
                    getMetadata: function () { return {getName: function () { return 'sap.m.Button'; }}; }
                }
            });

            result.value.fn.should.equal('[function namedFunction]');
            result.value.node.should.equal('[DOM DIV]');
            result.value.when.should.equal('1970-01-01T00:00:00.000Z');
            result.value.control.should.equal('[sap.m.Button#button1]');
        });

        it('should cut off data that is nested too deeply', function () {
            var result = modelUtils._clone(createChain(20));
            var walked = followChain(result.value);

            result.truncated.should.equal(true);
            walked.levels.should.equal(9);
            walked.end.should.match(/^… \(click to expand\) #[a-z0-9]+:\d+$/);
        });

        it('should not cut off an empty object or array at the depth limit', function () {
            var chain = createChain(8);
            var bottom = chain;

            while (bottom.child) {
                bottom = bottom.child;
            }
            bottom.emptyObject = {};
            bottom.emptyArray = [];

            var end = followChain(modelUtils._clone(chain).value).end;

            end.emptyObject.should.deep.equal({});
            end.emptyArray.should.deep.equal([]);
        });

        it('should keep the siblings of a value that throws when it is read', function () {
            var result = modelUtils._clone({
                ok: 1,
                invalidDate: new Date('not a date'),
                proxy: new Proxy({}, {get: function () { throw new Error('proxy'); }}),
                get getter() { throw new Error('getter'); }
            });

            result.value.ok.should.equal(1);
            result.value.invalidDate.should.match(/^\[unreadable: /);
            result.value.proxy.should.equal('[unreadable: proxy]');
            result.value.getter.should.equal('[unreadable: getter]');
        });

        it('should show BigInt and Symbol values instead of an empty object', function () {
            // Called through a lowercase alias: jshint's newcap takes BigInt for a constructor.
            var toBigInt = BigInt;
            var result = modelUtils._clone({big: toBigInt(10), sym: Symbol('s')});

            result.value.should.deep.equal({big: '10n', sym: 'Symbol(s)'});
        });

        it('should hand back the next levels when a truncation marker is expanded', function () {
            var marker = followChain(modelUtils._clone(createChain(20)).value).end;
            var walked = followChain(modelUtils.expandModelData(marker.split('#')[1]).value);

            // Another eight levels below the marker, then a marker of its own.
            walked.levels.should.equal(9);
            walked.end.should.match(/\(click to expand\) #/);

            // A click against an older render is rejected rather than answered with the
            // wrong branch.
            modelUtils.expandModelData('999:0').missing.should.equal(true);
        });

        it('should open the whole branch when the expansion is deep', function () {
            var marker = followChain(modelUtils._clone(createChain(30)).value).end;
            var walked = followChain(modelUtils.expandModelData(marker.split('#')[1], true).value);

            // The remaining levels arrive in one answer, with no marker left behind.
            walked.levels.should.equal(21);
            walked.end.leaf.should.equal('bottom');
        });

        it('should cap long arrays and report the remainder', function () {
            var long = [];

            for (var i = 0; i < 1500; i++) {
                long.push(i);
            }

            var result = modelUtils._clone(long);

            result.truncated.should.equal(true);
            result.value.length.should.equal(1001);
            result.value[1000].should.equal('[500 more items]');
        });

        it('should cap a flat object of scalars, which the node budget does not catch', function () {
            var wide = {};

            for (var i = 0; i < 1500; i++) {
                wide['key' + i] = i;
            }

            var result = modelUtils._clone(wide);

            result.truncated.should.equal(true);
            Object.keys(result.value).length.should.equal(1001);
            result.value['[truncated]'].should.equal('500 more entries');
        });

        it('should cut off a long string and say how much was dropped', function () {
            var result = modelUtils._clone({blob: new Array(10101).join('x')});

            result.truncated.should.equal(true);
            result.value.blob.should.equal(new Array(10001).join('x') + ' ... [100 more characters]');
        });
    });

    describe('#_getModelKind()', function () {
        it('should recognise the common model classes', function () {
            modelUtils._getModelKind('sap.ui.model.json.JSONModel').should.equal('JSON');
            modelUtils._getModelKind('sap.ui.model.odata.v2.ODataModel').should.equal('OData V2');
            modelUtils._getModelKind('sap.ui.model.odata.v4.ODataModel').should.equal('OData V4');
            modelUtils._getModelKind('sap.ui.model.resource.ResourceModel').should.equal('Resource');
            modelUtils._getModelKind('sap.ui.model.xml.XMLModel').should.equal('XML');
            modelUtils._getModelKind('my.own.Model').should.equal('Other');
        });
    });

    describe('#getModels()', function () {
        it('should report no support without the registries the scan walks', function () {
            window.sap = {ui: {require: function () { return undefined; }}};

            modelUtils.getModels().should.deep.equal({isSupported: false, models: []});
        });

        it('should list one row per model instance, not per registration', function () {
            var shared = createModel('sap.ui.model.resource.ResourceModel', {greeting: 'hi'});

            stubSapUi(
                {comp1: createOwner('comp1', 'my.Component', {'undefined': createModel('sap.ui.model.json.JSONModel', {a: 1}), i18n: shared})},
                {view1: createOwner('view1', 'sap.ui.core.mvc.XMLView', {i18n: shared})}
            );

            var models = modelUtils.getModels().models;

            models.length.should.equal(2);

            var resourceRow = models.filter(function (row) {
                return row.kind === 'Resource';
            })[0];

            resourceRow.name.should.equal('i18n');
            resourceRow.ownerCount.should.equal(2);
            resourceRow.ownerKind.should.equal('Component');
        });

        it('should label the default model and count its entries', function () {
            stubSapUi(
                {comp1: createOwner('comp1', 'my.Component', {'undefined': createModel('sap.ui.model.json.JSONModel', {a: 1, b: 2})})},
                {}
            );

            var row = modelUtils.getModels().models[0];

            row.name.should.equal('(default)');
            row.entries.should.equal(2);
            row.bindingMode.should.equal('TwoWay');
        });

        it('should mark the models the framework sets itself as internal', function () {
            // Fiori elements V2 also registers the app's OData model under a _templPriv name.
            var service = createModel('sap.ui.model.odata.v2.ODataModel', {});

            stubSapUi(
                {comp1: createOwner('comp1', 'my.Component', {
                    'undefined': service,
                    _templPrivGlobalService: service,
                    $componentState: createModel('sap.ui.model.json.JSONModel', {}),
                    _templPriv: createModel('sap.ui.model.json.JSONModel', {}),
                    _pageModel: createModel('sap.ui.model.json.JSONModel', {}),
                    // Declared in the app's manifest, so it is the app's own model.
                    '@i18n': createModel('sap.ui.model.resource.ResourceModel', {}),
                    _myModel: createModel('sap.ui.model.json.JSONModel', {}),
                    viewData: createModel('sap.ui.model.json.JSONModel', {})
                })},
                {}
            );

            var models = modelUtils.getModels().models;

            models.filter(function (row) { return row.internal; }).map(function (row) {
                return row.name;
            }).should.deep.equal(['$componentState', '_templPriv', '_pageModel']);
            models.filter(function (row) { return row.name === 'viewData'; })[0].internal.should.equal(false);
            // One app-facing name is enough to keep a model in view.
            models.filter(function (row) { return row.kind === 'OData V2'; })[0].internal.should.equal(false);
        });

        it('should pick up a Core model from what is propagated into the control tree', function () {
            stubSapUi({}, {
                view1: createOwner('view1', 'sap.ui.core.mvc.XMLView', {}, {global: createModel('sap.ui.model.json.JSONModel', {x: 1})})
            });

            var row = modelUtils.getModels().models[0];

            row.ownerKind.should.equal('Core');
            row.name.should.equal('global');
        });

        it('should not report a component model as a Core model when it propagates down', function () {
            var model = createModel('sap.ui.model.json.JSONModel', {x: 1});

            stubSapUi(
                {comp1: createOwner('comp1', 'my.Component', {shared: model})},
                {view1: createOwner('view1', 'sap.ui.core.mvc.XMLView', {}, {shared: model})}
            );

            var models = modelUtils.getModels().models;

            models.length.should.equal(1);
            models[0].ownerKind.should.equal('Component');
        });

        it('should still report a Core name for a model a component also owns', function () {
            var model = createModel('sap.ui.model.json.JSONModel', {x: 1});

            stubSapUi(
                {comp1: createOwner('comp1', 'my.Component', {device: model})},
                {view1: createOwner('view1', 'sap.ui.core.mvc.XMLView', {}, {device: model, alsoOnCore: model})}
            );

            var models = modelUtils.getModels().models;

            models.length.should.equal(1);
            models[0].name.should.equal('device, alsoOnCore');
            models[0].ownerCount.should.equal(2);
        });

        it('should point at a component root control and at an element itself', function () {
            stubSapUi(
                {comp1: createOwner('comp1', 'my.Component', {a: createModel('sap.ui.model.json.JSONModel', {})})},
                {view1: createOwner('view1', 'sap.ui.core.mvc.XMLView', {b: createModel('sap.ui.model.json.JSONModel', {})})}
            );

            var models = modelUtils.getModels().models;

            // A component is not in the control tree, but its root control is.
            models[0].ownerNavigationId.should.equal('comp1---rootView');
            models[1].ownerNavigationId.should.equal('view1');
        });

        it('should keep a Core model whose name a component also uses', function () {
            var coreBundle = createModel('sap.ui.model.resource.ResourceModel', {a: 1});
            var componentBundle = createModel('sap.ui.model.resource.ResourceModel', {b: 2});

            stubSapUi(
                {comp1: createOwner('comp1', 'my.Component', {i18n: componentBundle})},
                {
                    // Inside the component the name resolves to the component's bundle.
                    inside: createOwner('inside', 'sap.m.Button', {}, {i18n: componentBundle}),
                    // Outside it, the same name still resolves to the Core's bundle.
                    outside: createOwner('outside', 'sap.m.Text', {}, {i18n: coreBundle})
                }
            );

            var models = modelUtils.getModels().models;

            models.length.should.equal(2);
            models.filter(function (row) { return row.ownerKind === 'Core'; }).length.should.equal(1);
            models.filter(function (row) { return row.ownerKind === 'Component'; }).length.should.equal(1);
        });

        it('should hide the models only framework components own', function () {
            var service = createModel('sap.ui.model.odata.v4.ODataModel', {});
            // The class sits inside the sap.fe.core library, but the manifest says application.
            var app = createOwner('app', 'sap.fe.core.fpmExplorer.Component', {
                service: service,
                appData: createModel('sap.ui.model.json.JSONModel', {})
            });
            var template = createOwner('lr', 'sap.fe.templates.ListReport.Component', {
                service: service,
                viewData: createModel('sap.ui.model.json.JSONModel', {})
            });
            var renderer = createOwner('shell', 'sap.ushell.renderer.Renderer', {shellModel: createModel('sap.ui.model.json.JSONModel', {})});
            var legacyApp = createOwner('legacy', 'my.legacy.Component', {legacyData: createModel('sap.ui.model.json.JSONModel', {})});

            app.getManifestEntry = function () { return 'application'; };
            template.getManifestEntry = function () { return 'component'; };
            stubSapUi({app: app, lr: template, shell: renderer, legacy: legacyApp}, {});

            modelUtils.getModels().models.filter(function (row) { return row.internal; }).map(function (row) {
                return row.name;
            }).should.deep.equal(['viewData', 'shellModel']);
        });

        it('should hand the selected model its new id when the page is rescanned', function () {
            var kept = createModel('sap.ui.model.json.JSONModel', {a: 1});

            stubSapUi({comp1: createOwner('comp1', 'my.Component', {kept: kept})}, {});
            var oldId = modelUtils.getModels().models[0].id;

            // A model added in front of it moves it down the list.
            stubSapUi({
                comp0: createOwner('comp0', 'my.Other', {added: createModel('sap.ui.model.json.JSONModel', {})}),
                comp1: createOwner('comp1', 'my.Component', {kept: kept})
            }, {});
            var scan = modelUtils.getModels(oldId);

            scan.selectedId.should.equal(scan.models[1].id);
            scan.models[1].name.should.equal('kept');
            modelUtils.getModelDetails(scan.selectedId).data.should.deep.equal({a: 1});
        });

        it('should drop the selection when the selected model is gone after a rescan', function () {
            stubSapUi({comp1: createOwner('comp1', 'my.Component', {gone: createModel('sap.ui.model.json.JSONModel', {})})}, {});
            var oldId = modelUtils.getModels().models[0].id;

            stubSapUi({comp1: createOwner('comp1', 'my.Component', {other: createModel('sap.ui.model.json.JSONModel', {})})}, {});

            (modelUtils.getModels(oldId).selectedId === undefined).should.equal(true);
        });

        it('should not take a stale propagated model below the root for a Core model', function () {
            var removed = createModel('sap.ui.model.json.JSONModel', {x: 1});
            var child = createOwner('icon', 'sap.ui.core.Icon', {}, {appView: removed});

            // UI5 does not always re-propagate to internal children, so one can keep the
            // map its parent had before the model was removed.
            child.getParent = function () {
                return {isA: function (type) { return type === 'sap.ui.core.Element'; }};
            };
            stubSapUi({}, {icon: child});

            modelUtils.getModels().models.length.should.equal(0);
        });

        it('should skip destroyed owners', function () {
            var destroyed = createOwner('gone', 'sap.m.Button', {stale: createModel('sap.ui.model.json.JSONModel', {})});
            destroyed.bIsDestroyed = true;

            stubSapUi({}, {gone: destroyed});

            modelUtils.getModels().models.length.should.equal(0);
        });
    });

    describe('#getModelDetails()', function () {
        it('should return data, registrations, the service url and the size limit', function () {
            var model = createModel('sap.ui.model.odata.v2.ODataModel', undefined, {
                oData: {'Products(1)': {Name: 'Chair'}},
                getServiceUrl: function () { return '/odata/service/'; },
                getServiceMetadata: function () { return {version: '1.0'}; }
            });

            delete model.getData;
            stubSapUi({comp1: createOwner('comp1', 'my.Component', {products: model})}, {});

            var details = modelUtils.getModelDetails(modelUtils.getModels().models[0].id);

            details.summary.serviceUrl.should.equal('/odata/service/');
            details.data.should.deep.equal({'Products(1)': {Name: 'Chair'}});
            details.metadata.serviceMetadata.should.deep.equal({version: '1.0'});
            details.registrations[0].ownerId.should.equal('comp1');
            details.sizeLimit.should.equal(100);
        });

        it('should fall back to the entity cache when getData() answers null', function () {
            // sap.ui.model.odata.v2.ODataModel inherits getData() but always returns null.
            var model = createModel('sap.ui.model.odata.v2.ODataModel', null, {
                oData: {'Products(1)': {Name: 'Chair'}, 'Products(2)': {Name: 'Desk'}}
            });

            stubSapUi({comp1: createOwner('comp1', 'my.Component', {'undefined': model})}, {});

            var row = modelUtils.getModels().models[0];

            row.entries.should.equal(2);
            modelUtils.getModelDetails(row.id).data.should.deep.equal(model.oData);
        });

        it('should not read data from an OData V4 model, which has no client side cache', function () {
            var model = createModel('sap.ui.model.odata.v4.ODataModel', {shouldNotBeRead: true});

            stubSapUi({comp1: createOwner('comp1', 'my.Component', {'undefined': model})}, {});

            var row = modelUtils.getModels().models[0];

            row.entries.should.equal(0);
            modelUtils.getModelDetails(row.id).data.should.contain('no client side cache');
        });

        it('should serialize the document of an XMLModel instead of walking it', function () {
            var model = createModel('sap.ui.model.xml.XMLModel',
                new DOMParser().parseFromString('<root><item id="1"/></root>', 'text/xml'));

            stubSapUi({comp1: createOwner('comp1', 'my.Component', {tree: model})}, {});

            var details = modelUtils.getModelDetails(modelUtils.getModels().models[0].id);

            details.data.should.equal('<root><item id="1"/></root>');
        });

        it('should let the most specific resource bundle win over its fallbacks', function () {
            var model = createModel('sap.ui.model.resource.ResourceModel', undefined, {
                getResourceBundle: function () {
                    return {
                        aPropertyFiles: [
                            {mProperties: {greeting: 'Hallo'}},
                            {mProperties: {greeting: 'Hello', farewell: 'Bye'}}
                        ]
                    };
                }
            });

            stubSapUi({comp1: createOwner('comp1', 'my.Component', {i18n: model})}, {});

            var details = modelUtils.getModelDetails(modelUtils.getModels().models[0].id);

            details.data.should.deep.equal({greeting: 'Hallo', farewell: 'Bye'});
        });

        it('should report an index that is not in the last scan', function () {
            stubSapUi({comp1: createOwner('comp1', 'my.Component', {a: createModel('sap.ui.model.json.JSONModel', {})})}, {});

            var id = modelUtils.getModels().models[0].id;

            modelUtils.getModelDetails(id.replace(/-\d+$/, '-42')).missing.should.equal(true);
        });

        it('should reject an id handed out by an earlier scan', function () {
            stubSapUi({comp1: createOwner('comp1', 'my.Component', {a: createModel('sap.ui.model.json.JSONModel', {})})}, {});

            var staleId = modelUtils.getModels().models[0].id;

            // The app navigated: a different model now sits at the same index.
            stubSapUi({comp2: createOwner('comp2', 'my.Other', {b: createModel('sap.ui.model.json.JSONModel', {})})}, {});
            modelUtils.getModels();

            modelUtils.getModelDetails(staleId).missing.should.equal(true);
        });
    });

    describe('#getModelDetailsFormattedForDataView()', function () {
        it('should build a general and an owners section', function () {
            stubSapUi({comp1: createOwner('comp1', 'my.Component', {cart: createModel('sap.ui.model.json.JSONModel', {items: []})})}, {});

            var id = modelUtils.getModels().models[0].id;
            var formatted = modelUtils.getModelDetailsFormattedForDataView(modelUtils.getModelDetails(id));

            formatted.general.data.Names.should.equal('cart');
            formatted.general.data.Kind.should.equal('JSON');
            formatted.general.data['Size limit'].should.equal('100');
            // The key stays index plus owner kind: the page controlled model name has to
            // sit in the value, because the DataView escapes values but not keys.
            formatted.owners.data['1. Component'].should.equal('cart on comp1 (my.Component)');
        });

        it('should return an empty object for a missing model', function () {
            modelUtils.getModelDetailsFormattedForDataView({missing: true}).should.deep.equal({});
        });
    });
});
