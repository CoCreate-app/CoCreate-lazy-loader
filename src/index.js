(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(["./client"], function (CoCreateLazyLoader) {
            return factory(CoCreateLazyLoader)
        });
    } else if (typeof module === 'object' && module.exports) {
        const CoCreateLazyLoader = require("./server.js")
        module.exports = factory(CoCreateLazyLoader);
    } else {
        root.returnExports = factory(root["./client.js"]);
    }
}(typeof self !== 'undefined' ? self : this, function (CoCreateLazyLoader) {
    return CoCreateLazyLoader;
}));