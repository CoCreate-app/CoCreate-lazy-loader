import observer from "@cocreate/observer";

function listen(name, callback, selector) {
	const addedNodesObserverName = name + "LazyloadAddedNodesObserver";
	const attributesObserverName = name + "LazyloadAttributesObserver";
	async function observerCallback(mutation) {
		observer.uninit(addedNodesObserverName);
		observer.uninit(attributesObserverName);

		if (!window.CoCreate) window.CoCreate = {};

		if (window.CoCreate[name]) return;
		window.CoCreate[name] = {};
		// observer.uninit(name);

		const module = await callback();
		// observer.uninit(name);
		window.CoCreate[name] = module.default || module;

		dispatchComponentLoaded(name);
	}

	observer.init({
		name: addedNodesObserverName,
		types: ["addedNodes"],
		selector,
		callback: observerCallback
	});

	let selectorAttributes = [];
	let attributes = selector.split(",");
	for (let attribute of attributes) {
		let attr = attribute.trim();
		if (attr.startsWith("[")) {
			let pos = attr.indexOf("*");
			if (pos == -1) pos = attr.indexOf("=");
			if (pos !== -1) {
				attr = attr.slice(1, pos);
			} else {
				attr = attr.slice(1, -1);
			}
			selectorAttributes.push(attr);
		}
	}
	if (selectorAttributes.length > 0)
		observer.init({
			name: attributesObserverName,
			types: ["attributes"],
			attributeFilter: selectorAttributes,
			selector,
			callback: observerCallback
		});
}

export async function lazyLoad(name, selector, callback) {
	if (document.querySelector(selector)) {
		await dependency(name, await callback());
	} else {
		listen(name, callback, selector);
	}
}

export async function dependency(name, promise) {
	try {
		let component = await promise;
		if (!window.CoCreate) window.CoCreate = {};
		if (!window.CoCreate[name]) {
			window.CoCreate[name] = component.default || component;
			dispatchComponentLoaded(name);
		}
	} catch (error) {
		console.error("error loading chunck: ", error);
	}
}

function dispatchComponentLoaded(name) {
	document.dispatchEvent(
		new CustomEvent(name + "Loaded", {
			detail: { name }
		})
	);
}
