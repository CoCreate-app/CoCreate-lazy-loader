import observer from '@cocreate/observer';

function listen(name, callback, selector) {

    function observerCallback({ target }) {
        // let isInit = target.querySelector(selector)/testtt
        // if (isInit) {
        callback()
        // console.log('lazyloaded', selector)
        observer.uninit(observerCallback)
        dispatchComponentLoaded(name)
        // }
    }

    observer.init({
        name: 'lazyloadObserver',
        observe: ['childList'],
        target: selector,
        callback: observerCallback
    })

    let selectorAttributes = [];
    let attributes = selector.split(",")
    for (let attribute of attributes) {
        let attr = attribute.trim()
        if (attr.startsWith("[")) {
            let pos = attr.indexOf("*")
            if (pos == -1)
                pos = attr.indexOf("=")
            if (pos !== -1) {
                attr = attr.slice(1, pos)
            } else {
                attr = attr.slice(1, -1)
            }
            selectorAttributes.push(attr)
        }

    }
    if (selectorAttributes.length > 0)
        observer.init({
            name: 'lazyloadAttributeObserver',
            observe: ['attributes'],
            attributeName: selectorAttributes,
            target: selector,
            callback: observerCallback
        });

}

export async function lazyLoad(name, selector, callback) {
    if (document.querySelector(selector))
        await dependency(name, await callback())
    else
        listen(name, callback, selector)
}

export async function dependency(name, promise) {
    let component = await promise;
    Object.assign(window.CoCreate, {
        [name]: component.default
    });
    dispatchComponentLoaded(name)
}

function dispatchComponentLoaded(name) {
    document.dispatchEvent(new CustomEvent(name + 'Loaded', {
        detail: { name }
    }));
}
