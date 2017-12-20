"use strict";

var uuid = require('node-uuid');

const SEP = "/";
const ID_KEY = "id";
const ID_KEY_1 = "id1";
const SIGNALLING_TABLE_NAME = "signalling";
const CALL_TABLE_NAME = "call";
const FIRST_FROM_END = -1;


function mergeParts(pathUrl) {
    var newPath = "";
    var previousTermWasUuid = true;
    pathUrl.split(SEP).forEach(function(p){
        var sep = previousTermWasUuid || isUuid(p) ? SEP  : "_";
        if (newPath) {
            newPath += sep;
        }
        newPath += p;
        previousTermWasUuid = isUuid(p);
    });
    return newPath;
}
function isUuid(s) {
    return s.indexOf("-") != -1 || (!isNaN(parseFloat(s)) && isFinite(s));
}

var registeredListeners = [];

function Snap(v, ref) {
    console.log('got db object %s', JSON.stringify(v));
    this.v = v;
    this.ref = ref ? ref : v.id;
    this.key = this.ref;
    this.child = (key) => new Snap(this.v[key], this.ref);
    this.val = () => v;
    this.forEach = (f) => v.forEach((o) => f(new Snap(o, this.ref)));
    this.hasChild = (key) => this.v.hasOwnProperty(key);
    this.numChildren = () => v.length;
    this.exists = () => v;
}

var Dbref = function(hz, path) {
    this.hz = hz;
    this.path = mergeParts(path);
    this.dbName = "test";
    this.isRefForArray = false;
    this.includeInitial = true;
    var parts = path.split(SEP);
    this.key = parts[parts.length-1];
    
};

Dbref.prototype = {
    parent: function() {
        const parts = this.path.split(SEP);
        parts.splice(-1, 1);
        const parentPath = parts.join(SEP);
        return new Dbref(this.hz, parentPath);
    },
    onDisconnect: function(childPath) {
        console.log('onDisconnect is not implemented');
        return this;
    },
    cancel: () => console.log('cancel() is not implemented'),
        
    child: function(childPath) {
        if (!this.path) {
            return new Dbref(this.hz, childPath);
        }            
        return new Dbref(this.hz, this.path + SEP + childPath);
    },
    on: function(event, listener) {
        if (event === 'value') {
            this.onValue(listener);
            return;
        }
        if (event === 'array') {
            this.onArray(listener);
            return;
        }
        if (event === 'child_added') {
            this.onChild(listener);
            return;
        }
        if (event === 'child_appended') {
            this.includeInitial = false;
            this.onChild(listener);
            this.includeInitial = true;
            return;
        }
    },
    once: function(event, listener) {
        if (event === 'value') {
            this.onValueOnce(listener);
            return;
        }
        if (event === 'array') {
            this.onArrayOnce(listener);
            return;
        }
        console.error('once with %s event is not supported', event);
    },
    onValueOnce: function(listener) {
        this.onValue(function(snap) {
            listener(snap);
            this.off();
        }.bind(this));
    },
    onArrayOnce: function(listener) {
        this.isRefForArray = true;
        this.onValueOnce(listener);
        this.isRefForArray = false;        
    },
    onArray: function(listener) {
        this.isRefForArray = true;
        this.onValue(listener);
        this.isRefForArray = false;        
    },
    onValue: function(listener) {
        var expr = this.hz(this.getTableName());
        var hasOwnId = true;
        if (this.orderByFieldName || this.isRefForArray) {
            hasOwnId = false;
        }
        expr = this.addFilters(expr, hasOwnId);
        var subscription = expr.watch({includeInitial:true}).subscribe(
            (val) => {
                if (!val || val.length == 0) {
                    return;
                }
                if (hasOwnId && val.length == 1) {
                    var snap = new Snap(val[0]);
                    listener(snap);
                    return;
                }
                var snap = new Snap(val);
                listener(snap);
            },
            (err) => console.error('onValue failed at path %s with %s', this.path, err)
        );
        registeredListeners.push({that:this,subscription:subscription});        
    },
    onChild: function(listener) {
        var expr = this.hz(this.getTableName());
        if (this.path.indexOf('signalling') != -1) {
            this.orderByChild('timestamp');
        }
        expr = this.addFilters(expr, false);
        var subscription = expr.watch({includeInitial:this.includeInitial, rawChanges:true}).subscribe(
            (val) => {
                if (val.old_val && val.new_val) {
                    return;
                }
                let dbObj = val.new_val;
                if (val.old_val && Object.keys(val.old_val).length > 0) {
                    dbObj = val.old_val;
                }
                if (dbObj) {
                    if (Object.keys(dbObj).length === 0) {
                        return;
                    }
                    var snap = new Snap(dbObj);
                    listener(snap);
                    return;
                }
            },
            (err) => console.error('onChild failed at path %s with %s', this.path, err)
        );

        registeredListeners.push({that:this,subscription:subscription});        
    },
    _unsubscribe: function(s) {
        try {
            s.unsubscribe();
        } catch(err) {
            console.error(err);
        }
    },
    off: function(any) {
        var matchingThis = false;
        registeredListeners = registeredListeners.filter((l)=> {
            if (l.that != this) {
                return true;
            }
            matchingThis = true;
            this._unsubscribe(l.subscription);
            return false;
        });
        if (matchingThis) {
            return;
        }
        registeredListeners = registeredListeners.filter((l)=> {
            if (l.that.path !== this.path) {
                return true;
            }
            this._unsubscribe(l.subscription);
            return false;
        });
    },    
    off_: function(any) {
        var s = registeredListeners[this.path];
        if (!s) {
            return;
        }
        delete registeredListeners[this.path];
        try {
            s.unsubscribe();
        } catch(err) {
            console.error(err);
        }
    },
    pathPart: function(ix) {
        const parts = this.path.split(SEP);
        if (ix < 0) {
            return parts[parts.length+ix];
        }
        return parts[ix];
    },
    isPartlyUpdate: function() {
        if (!isUuid(this.pathPart(FIRST_FROM_END))) {
            return this.getTableName() != this.pathPart(FIRST_FROM_END);
        }
        return false;
    },
    update: function(data) {
        this.set(data);
    },
    set: function(data) {
        //TODO : completition listener - invoke on error at least
        console.log("store %s under path %s", JSON.stringify(data), this.path);
        let isEmpty = !data ||
            (Object.keys(data).length === 0 && data.constructor === Object);
        //RethinkDb does not respect jsonproperty annontations when converting pojo to map
        // so do it here before giving pojo to the rethinkdb
        var idsMap = this.getIds(true);
        // TODO: party updates are not supported for more then 1 level of nested maps
        //
        if (this.isPartlyUpdate()) {
            // like setValue on <callid>/callstate/<state>
            idsMap[this.pathPart(FIRST_FROM_END)] = data;
        } else {
            for (var k in data) {
                idsMap[k] = data[k];
            }
        }
        data = idsMap;

        var expr = this.hz(this.getTableName());
        if (isEmpty) {
            expr.remove(data);
            return;
        }
        expr.upsert(data)
    },
    remove: function() {
        var expr = this.hz(this.getTableName());
        var idsMap = this.getIds(true);
        expr.remove(idsMap);
    },
    removeAll: function() {
        var expr = this.hz(this.getTableName());
        var idsMap = this.getIds(false);
        expr.findAll(idsMap).fetch()
            .mergeMap(l => {
                expr.removeAll(l);
            })
            .subscribe({
                next(id)   { },
                error(err) { console.error(`Error: ${err}`) },
                complete() {  }
            });
    },
    push: function(o) {
        var ref = this.child(uuid.v4()); 
        if (!o) {
            return ref;
        }
        ref.set(o);
        return ref;
    },
    getTableName: function() {
        const parts = this.path.split(SEP);
        if (parts.length < 2) {
            return parts[0];
        }
        for (var i=1; i < parts.length; i++) {
            if (isUuid(parts[i])) {
                return parts[i-1];
            }
        }
        return parts[parts.length-1];        
    },
    getIds: function(hasOwnIdInPath) {
        const parts = this.path.split(SEP);
        var rv = {};
        var idIndex = 1;
        for (var i=1; i < parts.length; i++) {
            if (!isUuid(parts[i])) {
                continue;
            }
            rv["id"+idIndex++] = parts[i];
        }
        if (idIndex == 1) {
            return rv;
        }
        if (hasOwnIdInPath) {
            const idKey = "id" + (idIndex - 1);
            const id = rv[idKey];
            delete rv[idKey];
            rv[ID_KEY] = id;
        }
        return rv;
    },
    orderByChild: function(orderByFieldName, direction = 'ascending') {
        this.orderByFieldName = orderByFieldName;
        this.orderDirection = direction;
        return this;
    },
    limit: function(n) {
        this.limitTo = n;
        return this;
    },
    addFilters: function(expr, hasOwnIdInPath) {
        var ids = this.getIds(hasOwnIdInPath);
        var filterInfo = "";

        
        var id1 = ids[ID_KEY_1];
        if (id1) {
            expr = expr.findAll(ids);
            if (this.orderByFieldName) {
                expr = expr.order(this.orderByFieldName, this.orderDirection);
            }
            if (this.limitTo) {
                expr = expr.limit(this.limitTo);
            }
            filterInfo += "index id1->" + id1 + ",";
        } else {
            var id = ids[ID_KEY];
            if (id) {
                delete ids[ID_KEY];
                expr = expr.find(id);
                filterInfo += "index id->" + id + ",";
            }
        }
        console.log("added filters %s for request to table %s orderby[%s]",
                    this.getTableName(), filterInfo, this.orderByFieldName);
        return expr;

    }
};

console.log(mergeParts("sdp/request/1/2"))
var d = new Dbref(null, "sdp/request/1/2");

console.log(d.parent().key);
console.log(isUuid("12345"))
console.log(isUuid("12345a"))
console.log(isUuid("12345a-av"))

module.exports = Dbref;
