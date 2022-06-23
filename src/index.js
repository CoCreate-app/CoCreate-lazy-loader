import observer from '@cocreate/observer';

export function addComponent(key, component) {
    this[key] = component;
}

export function removeComponent(key) {
    if (this[key]) {}
}

function listen(callback, selector) {

    function observerCallback({ target }) {
        // let isInit = target.querySelector(selector)
        // if (isInit) {
            callback()
            // console.log('lazyloaded', selector)
            observer.uninit(observerCallback)
        // }
    }

    observer.init({
        name: 'lazyloadObserver',
        observe: ['childList'],
        target: selector,
        callback: observerCallback
    })

    let selectorAttributes  = [];
    let attributes = selector.split(",")
    for (let attribute of attributes){
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

export async function lazyLoad(name, selector, cb) {
    async function cc() {
        let component = (await cb()).default;
        Object.assign(window.CoCreate, {
            [name]: component
        })
    }

    if (document.querySelector(selector))
        await cc()
    else
        listen(cc, selector)

}

export async function dependency(name, promise) {
    let module = await promise;
    Object.assign(window.CoCreate, {
        [name]: module.default
    });
}