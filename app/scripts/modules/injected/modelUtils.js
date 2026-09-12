/* globals WeakRef */
/* jshint latedef: nofunc */

'use strict';

// Size caps for model data. The message bus already drops functions and marks circular
// references, but it does not bound how much it copies, and an OData entity cache is
// unbounded application state.
var MAX_DEPTH = 8;
// Cap for reading a whole branch at once: past any real model, clear of the stack limit.
var MAX_DEEP_DEPTH = 200;
var MAX_NODES = 20000;
var MAX_ENTRIES = 1000;
var MAX_STRING_LENGTH = 10000;

/**
 * Whether this framework version can be scanned at all. The registries the scan walks
 * arrived in UI5 1.67, so their presence is the version check.
 * @returns {boolean}
 * @private
 */
function _isSupported() {
    var Element = sap.ui.require('sap/ui/core/Element');

    return !!(sap.ui.require('sap/ui/core/ElementRegistry') || (Element && Element.registry));
}

/**
 * Whether a ManagedObject has been destroyed. isDestroyed() only exists from UI5 1.120,
 * so older versions read the flag behind it.
 * @param {Object} managedObject
 * @returns {boolean}
 * @private
 */
function _isDestroyed(managedObject) {
    if (typeof managedObject.isDestroyed === 'function') {
        return managedObject.isDestroyed();
    }

    return !!managedObject.bIsDestroyed;
}

/**
 * Returns an object with all registered elements, keyed by their ID.
 * @returns {Object}
 * @private
 */
function _getAllElements() {
    var ElementRegistry = sap.ui.require('sap/ui/core/ElementRegistry');
    var Element = sap.ui.require('sap/ui/core/Element');

    if (ElementRegistry) {
        return ElementRegistry.all();
    }

    return Element && Element.registry ? Element.registry.all() : {};
}

/**
 * Returns an object with all component instances, keyed by their ID.
 * @returns {Object}
 * @private
 */
function _getAllComponents() {
    var ComponentRegistry = sap.ui.require('sap/ui/core/ComponentRegistry');
    var Component = sap.ui.require('sap/ui/core/Component');

    if (ComponentRegistry) {
        return ComponentRegistry.all();
    }

    return Component && Component.registry ? Component.registry.all() : {};
}

/**
 * Collects the models that reach one element from above it, which is where the Core's
 * models end up. No version exposes them on the Core facade, and the setter is gone in
 * UI5 2.x, but every version propagates them down.
 * One name can carry different instances in different subtrees, so this collects pairs
 * rather than a map: keying by name alone would drop a Core "i18n" as soon as any
 * component declared its own. The caller subtracts the pairs an owner already registered;
 * what is left was set on the Core.
 * @param {Object} element
 * @param {Array} pairs - collected [{name, model}], appended to in place
 * @param {Array} seen - the oModels objects already read, appended to in place
 * @private
 */
function _collectPropagatedModels(element, pairs, seen) {
    var propagated = element.oPropagatedProperties && element.oPropagatedProperties.oModels;

    // An element with no own models is handed its parent's map by reference, so a whole
    // subtree shares one object and reading it once is enough.
    if (!propagated || seen.indexOf(propagated) !== -1) {
        return;
    }

    seen.push(propagated);

    for (var name in propagated) {
        if (Object.prototype.hasOwnProperty.call(propagated, name)) {
            var model = propagated[name];
            var isKnown = pairs.some(function (pair) {
                return pair.name === name && pair.model === model;
            });

            if (!isKnown) {
                pairs.push({name: name, model: model});
            }
        }
    }
}

/**
 * Handles everything that is not an object, plus over-long strings.
 * @param {*} value
 * @param {Object} state - {nodes, truncated, stack}
 * @returns {Object} {done: boolean, value: *}
 * @private
 */
function _cloneScalar(value, state) {
    var type = typeof value;

    if (value === null || type === 'boolean' || type === 'number' || type === 'undefined') {
        return {done: true, value: value};
    }

    if (type === 'string') {
        if (value.length > MAX_STRING_LENGTH) {
            state.truncated = true;
            return {
                done: true,
                value: value.slice(0, MAX_STRING_LENGTH) + ' ... [' + (value.length - MAX_STRING_LENGTH) + ' more characters]'
            };
        }
        return {done: true, value: value};
    }

    if (type === 'function') {
        return {done: true, value: '[function ' + (value.name || 'anonymous') + ']'};
    }

    return {done: false};
}

/**
 * Renders objects that must not be walked into as a short tag. Without this they reach
 * the message bus, which flattens anything that is not a plain object to '<OBJECT>'.
 * @param {Object} object
 * @returns {string|undefined} the tag, or undefined when the object should be walked
 * @private
 */
function _getObjectTag(object) {
    if (object instanceof Date) {
        return object.toISOString();
    }

    if (object instanceof Error) {
        return '[Error: ' + object.message + ']';
    }

    if (object instanceof Node) {
        return '[DOM ' + (object.nodeName || 'Node') + ']';
    }

    if (object instanceof Promise) {
        return '[Promise]';
    }

    if (typeof object.isA === 'function' && object.isA('sap.ui.base.ManagedObject')) {
        return '[' + object.getMetadata().getName() + '#' + object.getId() + ']';
    }

    return undefined;
}

/**
 * Copies at most MAX_ENTRIES keyed entries into a plain object.
 * @param {Array} keys - the keys to copy
 * @param {Function} readValue - reads the value for a key
 * @param {Object} state
 * @param {number} depth
 * @returns {Object}
 * @private
 */
function _cloneEntries(keys, readValue, state, depth) {
    var result = {};

    keys.slice(0, MAX_ENTRIES).forEach(function (key) {
        result[String(key)] = _safeClone(readValue(key), state, depth + 1);
    });

    if (keys.length > MAX_ENTRIES) {
        state.truncated = true;
        result['[truncated]'] = keys.length - MAX_ENTRIES + ' more entries';
    }

    return result;
}

/**
 * Copies an array, a Map, a Set or a plain object, cloning every entry.
 * @param {Object} object
 * @param {Object} state
 * @param {number} depth
 * @returns {Object|Array}
 * @private
 */
function _cloneContainer(object, state, depth) {
    if (Array.isArray(object) || object instanceof Set) {
        var values = Array.isArray(object) ? object : Array.from(object);
        var result = values.slice(0, MAX_ENTRIES).map(function (entry) {
            return _safeClone(entry, state, depth + 1);
        });

        if (values.length > MAX_ENTRIES) {
            state.truncated = true;
            result.push('[' + (values.length - MAX_ENTRIES) + ' more items]');
        }

        return result;
    }

    if (object instanceof Map) {
        return _cloneEntries(Array.from(object.keys()), function (key) {
            return object.get(key);
        }, state, depth);
    }

    // A flat map of scalars - an entity cache, a resource bundle - would otherwise slip
    // past the node budget, which only counts objects.
    return _cloneEntries(Object.keys(object), function (key) {
        return object[key];
    }, state, depth);
}

// Sub-objects _safeClone stopped at, indexed by the marker it handed out. Weak, so a
// closed app's model is not pinned.
var expandable = [];
// Stamps the markers of the current render, so a click against an older one is rejected.
// Random rather than sequential, which also keeps model data from reading as a marker.
var expandToken = _newExpandToken();

/**
 * Returns a stamp for a fresh set of markers.
 * @returns {string}
 * @private
 */
function _newExpandToken() {
    return Math.random().toString(36).slice(2, 10);
}

/**
 * Creates a copy of arbitrary model data that can cross the message bus.
 * Cycles, functions, DOM nodes and UI5 objects become short tags, and depth, node count,
 * entry count and string length are capped.
 * @param {*} value - the value to clone
 * @param {Object} state - {nodes, truncated, stack, maxDepth}
 * @param {number} depth - current depth
 * @returns {*} a JSON serializable copy
 * @private
 */
function _safeClone(value, state, depth) {
    var scalar = _cloneScalar(value, state);

    if (scalar.done) {
        return scalar.value;
    }

    if (state.nodes >= MAX_NODES) {
        state.truncated = true;
        return '[truncated: more than ' + MAX_NODES + ' nodes]';
    }
    state.nodes++;

    if (depth > state.maxDepth) {
        state.truncated = true;
        // JSONDetailView matches this shape, so its regex and this string travel together.
        return '… (click to expand) #' +
            expandToken + ':' + (expandable.push(new WeakRef(value)) - 1);
    }

    if (state.stack.indexOf(value) !== -1) {
        return '[circular]';
    }

    var tag = _getObjectTag(value);

    if (tag !== undefined) {
        return tag;
    }

    state.stack.push(value);

    var result;

    try {
        result = _cloneContainer(value, state, depth);
    } catch (error) {
        result = '[unreadable: ' + error.message + ']';
    }

    state.stack.pop();

    return result;
}

/**
 * Runs _safeClone with a fresh budget.
 * @param {*} value
 * @param {number} [maxDepth] - depth cap, MAX_DEPTH when omitted
 * @returns {Object} {value: *, truncated: boolean}
 * @private
 */
function _clone(value, maxDepth) {
    var state = {nodes: 0, truncated: false, stack: [], maxDepth: maxDepth || MAX_DEPTH};

    return {
        value: _safeClone(value, state, 0),
        truncated: state.truncated
    };
}

/**
 * Maps a model class name to a short, sortable label.
 * @param {string} className
 * @returns {string}
 * @private
 */
function _getModelKind(className) {
    var type = (className || '').toLowerCase();

    if (type.indexOf('odata.v4') !== -1) {
        return 'OData V4';
    }
    if (type.indexOf('odata.v2') !== -1) {
        return 'OData V2';
    }
    if (type.indexOf('odata') !== -1) {
        return 'OData';
    }
    if (type.indexOf('resource') !== -1) {
        return 'Resource';
    }
    if (type.indexOf('json') !== -1) {
        return 'JSON';
    }
    if (type.indexOf('xml') !== -1) {
        return 'XML';
    }

    return 'Other';
}

/**
 * Reads the texts of a ResourceModel.
 * @param {Object} model
 * @returns {*}
 * @private
 */
function _getResourceBundleTexts(model) {
    var bundle = model.getResourceBundle();

    if (bundle && typeof bundle.then === 'function') {
        // Async ResourceModel: the resolved bundle is cached on the model itself.
        bundle = model._oResourceBundle;
    }

    if (!bundle) {
        return '[resource bundle is still loading]';
    }

    var texts = {};

    /**
     * Merges one bundle's property files into the result.
     * @param {Object} source - a ResourceBundle
     */
    var merge = function (source) {
        var files = (source && source.aPropertyFiles) || [];

        // Later files are fallback locales, so iterate backwards and let the most
        // specific one win.
        for (var i = files.length - 1; i >= 0; i--) {
            var properties = files[i] && files[i].mProperties;

            if (properties) {
                Object.keys(properties).forEach(function (key) {
                    texts[key] = properties[key];
                });
            }
        }
    };

    merge(bundle);
    // Bundles added through enhanceWith override the base bundle.
    (bundle.aCustomBundles || []).forEach(merge);

    return texts;
}

/**
 * Reads the raw data of a model, whatever kind it is.
 * @param {Object} model
 * @returns {*}
 * @private
 */
function _readModelData(model) {
    try {
        // OData V4 holds no client side entity cache - the data lives in the bindings -
        // so reading it would answer an empty object and read as an empty model.
        if (_getModelKind(model.getMetadata().getName()) === 'OData V4') {
            return '[OData V4 keeps no client side cache - see the Metadata tab]';
        }

        if (typeof model.getResourceBundle === 'function') {
            return _getResourceBundleTexts(model);
        }

        if (typeof model.getData === 'function') {
            var data = model.getData();

            if (data instanceof Document) {
                return new XMLSerializer().serializeToString(data);
            }

            // OData V2 inherits getData() but always answers null - its entity cache
            // lives in oData, so fall through instead of reporting an empty model.
            if (data !== null && data !== undefined) {
                return data;
            }
        }

        // OData V2 and V1 keep their entity cache here.
        if (model.oData !== undefined) {
            return model.oData;
        }

        if (typeof model.getObject === 'function') {
            return model.getObject('/');
        }
    } catch (error) {
        return '[data unavailable: ' + error.message + ']';
    }

    return undefined;
}

/**
 * Reads the service metadata of a model, if it has any.
 * @param {Object} model
 * @returns {*}
 * @private
 */
function _readModelMetadata(model) {
    var result = {};

    try {
        if (typeof model.getServiceMetadata === 'function') {
            result.serviceMetadata = model.getServiceMetadata();
        }

        if (typeof model.getServiceAnnotations === 'function') {
            result.annotations = model.getServiceAnnotations();
        }

        if (!result.serviceMetadata && typeof model.getMetaModel === 'function') {
            var metaModel = model.getMetaModel();

            if (metaModel) {
                result.metaModel = typeof metaModel.getData === 'function' ?
                    metaModel.getData() :
                    metaModel.getObject && metaModel.getObject('/');
            }
        }
    } catch (error) {
        return '[metadata unavailable: ' + error.message + ']';
    }

    return Object.keys(result).length ? result : undefined;
}

/**
 * Counts the top level entries of a data structure.
 * @param {*} data
 * @returns {number}
 * @private
 */
function _getEntryCount(data) {
    if (Array.isArray(data)) {
        return data.length;
    }

    if (data && typeof data === 'object') {
        return Object.keys(data).length;
    }

    return 0;
}

/**
 * Returns the id of a component's root control, which stands in for the component in the
 * control tree.
 * @param {Object} component
 * @returns {string}
 * @private
 */
function _getRootControlId(component) {
    try {
        var rootControl = typeof component.getRootControl === 'function' && component.getRootControl();

        return rootControl ? rootControl.getId() : '';
    } catch (error) {
        return '';
    }
}

/**
 * Describes the object a model is set on.
 * @param {Object} owner - Component or Element, ignored for the Core
 * @param {string} kind - 'Core', 'Component' or 'Element'
 * @returns {Object}
 * @private
 */
function _describeOwner(owner, kind) {
    if (kind === 'Core') {
        return {
            kind: 'Core',
            id: 'sap.ui.core.Core',
            type: 'sap.ui.core.Core',
            componentId: '',
            navigationId: ''
        };
    }

    var Component = sap.ui.require('sap/ui/core/Component');
    var ownerComponent = Component && Component.getOwnerComponentFor(owner);

    return {
        kind: kind,
        id: owner.getId(),
        type: owner.getMetadata().getName(),
        // For a nested component this is the parent component, which is what makes
        // component reuse readable in the list.
        componentId: ownerComponent ? ownerComponent.getId() : '',
        // Where to reveal this owner in the control tree.
        navigationId: kind === 'Component' ? _getRootControlId(owner) : owner.getId()
    };
}

/**
 * Checks whether an object has any own models.
 * @param {Object} owner
 * @returns {boolean}
 * @private
 */
function _hasModels(owner) {
    for (var key in owner.oModels) {
        if (Object.prototype.hasOwnProperty.call(owner.oModels, key)) {
            return true;
        }
    }

    return false;
}

/**
 * Walks every place a model can be set and groups the registrations per model instance.
 * Only own models are read, never propagated ones, so a model set once on a component
 * does not show up again for each of its hundreds of children.
 * @returns {Array} [{model: Object, registrations: Array}]
 * @private
 */
function _collectModels() {
    var entries = [];

    /**
     * Adds one model registration to the result.
     * @param {Object} ownerInfo
     * @param {string} key - the name the model is registered under
     * @param {Object} model
     * @param {boolean} [onlyUnknown] - skip registrations that some owner already has
     */
    var addModel = function (ownerInfo, key, model, onlyUnknown) {
        if (!model || typeof model.getMetadata !== 'function') {
            return;
        }

        // UI5 stores the default model under the string key 'undefined'.
        var name = (key === 'undefined' || key === '') ? '' : key;
        var entry;

        // A page holds tens of models, so a linear scan beats keeping a Map.
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].model === model) {
                entry = entries[i];
                break;
            }
        }

        // The propagated pairs repeat every owned model, so the Core pass subtracts them.
        // Match on the name as well as the instance: the same model set on the Core under
        // a second name is a binding name of its own.
        if (entry && onlyUnknown && entry.registrations.some(function (registration) {
            return registration.name === name;
        })) {
            return;
        }

        if (!entry) {
            entry = {model: model, registrations: []};
            entries.push(entry);
        }

        entry.registrations.push({name: name, owner: ownerInfo});
    };

    /**
     * Adds every own model of one owner to the result.
     * @param {Object} ownerInfo
     * @param {Object} models
     */
    var addOwner = function (ownerInfo, models) {
        Object.keys(models).forEach(function (key) {
            addModel(ownerInfo, key, models[key]);
        });
    };

    var components = _getAllComponents();
    Object.keys(components).forEach(function (id) {
        var component = components[id];

        if (component && !_isDestroyed(component) && _hasModels(component)) {
            addOwner(_describeOwner(component, 'Component'), component.oModels);
        }
    });

    // One walk: a Fiori app registers tens of thousands of elements, and describing an
    // owner is not free, so both the own models and the propagated ones are read here.
    var propagatedPairs = [];
    var seenPropagated = [];
    var elements = _getAllElements();

    Object.keys(elements).forEach(function (id) {
        var element = elements[id];

        if (!element || _isDestroyed(element)) {
            return;
        }

        if (_hasModels(element)) {
            addOwner(_describeOwner(element, 'Element'), element.oModels);
        }

        _collectPropagatedModels(element, propagatedPairs, seenPropagated);
    });

    var coreOwner = _describeOwner(null, 'Core');

    propagatedPairs.forEach(function (pair) {
        addModel(coreOwner, pair.name, pair.model, true);
    });

    return entries;
}

// The scan result of the last getModels() call. Ids carry the scan number so a selection
// made against an older list is rejected, and models are held weakly so a closed app's
// entity cache is not pinned for the lifetime of the document.
var lastScan = [];
var scanCount = 0;

/**
 * Builds the row shown in the models list for one model instance.
 * @param {Object} entry - {model, registrations}
 * @param {number} index
 * @param {*} data - the model's data, already read by the caller
 * @returns {Object}
 * @private
 */
function _createSummary(entry, index, data) {
    var model = entry.model;
    var className = model.getMetadata().getName();
    var names = [];

    entry.registrations.forEach(function (registration) {
        var name = registration.name || '(default)';

        if (names.indexOf(name) === -1) {
            names.push(name);
        }
    });

    var primaryOwner = entry.registrations[0].owner;

    return {
        id: 'model-' + scanCount + '-' + index,
        name: names.join(', '),
        // UI5 names its own internal models with a leading $.
        internal: names.every(function (name) {
            return name.charAt(0) === '$';
        }),
        type: className,
        kind: _getModelKind(className),
        owner: primaryOwner.id,
        ownerKind: primaryOwner.kind,
        ownerNavigationId: primaryOwner.navigationId,
        ownerCount: entry.registrations.length,
        bindingMode: model.getDefaultBindingMode(),
        serviceUrl: (typeof model.getServiceUrl === 'function' && model.getServiceUrl()) || model.sServiceUrl || '',
        entries: _getEntryCount(data)
    };
}

module.exports = {

    /**
     * Scans the page for every model instance and returns one row per instance.
     * @returns {Object} {isSupported: boolean, models: Array}
     */
    getModels: function () {
        if (!_isSupported()) {
            return {isSupported: false, models: []};
        }

        // This is evaluated inline in the initial-data payload, so an escaping throw
        // would cost the panel its control tree and application information as well.
        try {
            scanCount++;

            var entries = _collectModels();
            var models = entries.map(function (entry, index) {
                return _createSummary(entry, index, _readModelData(entry.model));
            });

            lastScan = entries.map(function (entry) {
                return {ref: new WeakRef(entry.model), registrations: entry.registrations};
            });

            return {isSupported: true, models: models};
        } catch (error) {
            console.warn(error);
            lastScan = [];

            return {isSupported: true, models: []};
        }
    },

    /**
     * Returns data, metadata and details for one model of the last scan.
     * @param {string} modelId - id handed out by getModels()
     * @returns {Object}
     */
    getModelDetails: function (modelId) {
        var parts = String(modelId).split('-');
        var entry = parseInt(parts[1], 10) === scanCount && lastScan[parseInt(parts[2], 10)];
        var model = entry && entry.ref.deref();

        if (!model) {
            return {missing: true};
        }

        // A new render invalidates every marker the panel is still showing.
        expandable = [];
        expandToken = _newExpandToken();

        // Model data is arbitrary application state. If reading it throws, the panel must
        // still get an answer, otherwise its panes keep showing the previous model.
        try {
            var data = _readModelData(model);
            var clonedData = _clone(data);

            return {
                summary: _createSummary({model: model, registrations: entry.registrations}, parseInt(parts[2], 10), data),
                registrations: entry.registrations.map(function (registration) {
                    return {
                        name: registration.name || '(default)',
                        ownerKind: registration.owner.kind,
                        ownerId: registration.owner.id,
                        ownerType: registration.owner.type,
                        componentId: registration.owner.componentId
                    };
                }),
                data: clonedData.value,
                dataTruncated: clonedData.truncated,
                metadata: _clone(_readModelMetadata(model)).value,
                sizeLimit: typeof model.iSizeLimit === 'number' ? model.iSizeLimit : undefined
            };
        } catch (error) {
            console.warn(error);
            return {missing: true};
        }
    },

    /**
     * Returns the levels below one truncation marker.
     * @param {string} expandId - the id carried by the marker
     * @param {boolean} [deep] - open the whole branch instead of the next MAX_DEPTH levels
     * @returns {Object} {value: *, truncated: boolean} or {missing: true}
     */
    expandModelData: function (expandId, deep) {
        var parts = String(expandId).split(':');
        var held = parts[0] === expandToken && expandable[parseInt(parts[1], 10)];
        var value = held && held.deref();

        if (!value) {
            return {missing: true};
        }

        try {
            return _clone(value, deep ? MAX_DEEP_DEPTH : MAX_DEPTH);
        } catch (error) {
            console.warn(error);
            return {missing: true};
        }
    },

    /**
     * Formats model details for the DataView of the Models tab.
     * @param {Object} details - result of getModelDetails()
     * @returns {Object}
     */
    getModelDetailsFormattedForDataView: function (details) {
        if (!details || details.missing) {
            return {};
        }

        var summary = details.summary;
        var general = {
            Names: summary.name,
            Class: summary.type,
            Kind: summary.kind,
            'Default binding mode': summary.bindingMode || '-',
            'Top level entries': String(summary.entries),
            'Registered on': summary.ownerCount + ' object(s)'
        };

        if (summary.serviceUrl) {
            general['Service URL'] = summary.serviceUrl;
        }

        if (details.sizeLimit !== undefined) {
            general['Size limit'] = String(details.sizeLimit);
        }

        if (details.dataTruncated) {
            general['Data truncated'] = 'yes - too large to transfer in full';
        }

        var owners = {};
        details.registrations.forEach(function (registration, index) {
            // The model name is page controlled, so it belongs in the value: the DataView
            // escapes values but writes keys into innerHTML unescaped.
            var value = registration.name + ' on ' + registration.ownerId +
                ' (' + registration.ownerType + ')';

            if (registration.componentId && registration.componentId !== registration.ownerId) {
                value += ' - owned by component ' + registration.componentId;
            }

            owners[index + 1 + '. ' + registration.ownerKind] = value;
        });

        return {
            general: {
                options: {
                    title: 'Model',
                    expandable: true,
                    expanded: true
                },
                data: general
            },
            owners: {
                options: {
                    title: 'Set on',
                    expandable: true,
                    expanded: true
                },
                data: owners
            }
        };
    },

    // Exposed for tests.
    _clone: _clone,
    _getModelKind: _getModelKind
};
