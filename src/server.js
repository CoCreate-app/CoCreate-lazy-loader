const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const vm = require("vm");
const Config = require("@cocreate/config");
const { getValueFromObject, objectToSearchParams } = require("@cocreate/utils");

class CoCreateLazyLoader {
	constructor(server, crud, files) {
		this.server = server;
		this.wsManager = crud.wsManager;
		this.crud = crud;
		this.files = files;
		this.exclusion = { ...require.cache };
		this.modules = {};
		this.init();
	}

	async init() {
		const scriptsDirectory = "./scripts";

		try {
			await fs.mkdir(scriptsDirectory, { recursive: true });
		} catch (error) {
			console.error("Error creating scripts directory:", error);
			throw error; // Halt execution if directory creation fails
		}

		this.wsManager.on("endpoint", (data) => {
			this.executeEndpoint(data);
		});

		this.modules = await Config("modules", false, false);
		if (!this.modules) return;
		else this.modules = this.modules.modules;

		for (let name of Object.keys(this.modules)) {
			this.wsManager.on(this.modules[name].event, (data) => {
				this.executeScriptWithTimeout(name, data);
			});
		}

		this.server.https.on("request", (req, res) => this.request(req, res));
		this.server.http.on("request", (req, res) => this.request(req, res));
	}

	async request(req, res) {
		try {
			// TODO: track usage
			const urlObject = new URL(`http://${req.headers.host}${req.url}`);
			const hostname = urlObject.hostname;
			let organization;

			try {
				organization = await this.crud.getOrganization({
					host: hostname
				});
			} catch {
				return this.files.send(
					req,
					res,
					this.crud,
					organization,
					urlObject
				);
			}

			if (urlObject.pathname.startsWith("/webhooks/")) {
				let name = req.url.split("/")[2]; // Assuming URL structure is /webhooks/name/...
				if (this.modules[name]) {
					this.executeScriptWithTimeout(name, {
						req,
						res,
						host: hostname,
						organization,
						urlObject,
						organization_id: organization._id
					});
				} else {
					// Handle unknown module or missing webhook method
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Not found" }));
				}
			} else {
				this.files.send(req, res, this.crud, organization, urlObject);
			}
		} catch (error) {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Invalid host format");
		}
	}

	async executeEndpoint(data) {
		try {
			if (!data.method || !data.endpoint) {
				throw new Error("Request missing 'method' or 'endpoint'.");
			}

			let name = data.method.split(".")[0];
			let method = data.endpoint.split(" ")[0].toUpperCase();

			// data = await this.processOperators(data, "", name);

			let apiConfig = await this.getApiConfig(data, name);
			// --- Refined Validation ---
			if (!apiConfig) {
				throw new Error(`Configuration missing for API: '${name}'.`);
			}
			if (!apiConfig.url) {
				throw new Error(
					`Configuration error: Missing base url for API '${name}'.`
				);
			}
			// apiConfig = await this.processOperators(data, getApiConfig, "");

			let override = apiConfig.endpoint?.[data.endpoint] || {};

			let url = apiConfig.url; // Base URL
			url = url.endsWith("/") ? url.slice(0, -1) : url;

			let path = override.path || data.endpoint.split(" ")[1];
			url += path.startsWith("/") ? path : `/${path}`;

			url += objectToSearchParams(data[name].$searchParams);

			// User's proposed simplification:
			let headers = apiConfig.headers; // Default headers
			if (override.headers) {
				headers = { ...headers, ...override.headers }; // Correct idea for merging
			}

			// let body = formatRequestBody(data[name]);

			let formatType = data.formatType || "json";
			const timeout = 10000; // Set default timeout in ms (e.g., 10 seconds)
			let options = { method, headers, timeout };

			// Only add body for methods that support it (not GET or HEAD)
			if (!["GET", "HEAD"].includes(method)) {
				let { body } = this.formatRequestBody(data[name], formatType);
				options.body = body;
			}
			// For GET/HEAD, do not create or send a body; all params should be in the URL

			const response = await this.makeHttpRequest(url, options);

			// If the response is not ok, makeHttpRequest will throw and be caught below.
			// If you want to include more info in the error, you can log or attach response details here.

			data[name] = await response.json();

			this.wsManager.send(data);
		} catch (error) {
			// Add more detail to the error for debugging 404s
			data.error = error.message;
			if (error.response) {
				data.status = error.response.status;
				data.statusText = error.response.statusText;
				data.responseData = error.response.data;
			}
			if (data.req) {
				data.res.writeHead(400, {
					"Content-Type": "application/json"
				});
				data.res.end(
					JSON.stringify({
						error: data.error,
						status: data.status,
						statusText: data.statusText,
						responseData: data.responseData
					})
				);
			}
			if (data.socket) {
				this.wsManager.send(data);
			}
		}
	}

	/**
	 * Formats the request body payload based on the specified format type.
	 *
	 * @param {object | string} payload The data intended for the request body.
	 * @param {string} [formatType='json'] The desired format ('json', 'form-urlencoded', 'text', 'multipart', 'xml'). Defaults to 'json'.
	 * @returns {{ body: string | Buffer | FormData | null, contentTypeHeader: string | null }}
	 * An object containing the formatted body and the corresponding Content-Type header.
	 * Returns null body/header on error or for unsupported types.
	 */
	formatRequestBody(payload, formatType = "json") {
		let body = null;
		let contentTypeHeader = null;

		try {
			switch (formatType.toLowerCase()) {
				case "json":
					body = JSON.stringify(payload);
					contentTypeHeader = "application/json; charset=utf-8";
					break;

				case "form-urlencoded":
					// In Node.js using querystring:
					// const querystring = require('node:querystring');
					// body = querystring.stringify(payload);
					// Or using URLSearchParams (Node/Browser):
					body = new URLSearchParams(payload).toString();
					contentTypeHeader =
						"application/x-www-form-urlencoded; charset=utf-8";
					break;

				case "text":
					if (typeof payload === "string") {
						body = payload;
					} else if (
						payload &&
						typeof payload.toString === "function"
					) {
						// Attempt conversion for simple objects/values, might need refinement
						body = payload.toString();
					} else {
						throw new Error(
							"Payload must be a string or convertible to string for 'text' format."
						);
					}
					contentTypeHeader = "text/plain; charset=utf-8";
					break;

				case "multipart":
					// COMPLEX: Requires FormData (browser) or form-data library (Node)
					// Needs specific logic to handle payload structure (identifying files vs fields)
					// const formData = buildFormData(payload); // Placeholder for complex logic
					// body = formData; // The FormData object itself or its stream
					// contentTypeHeader = formData.getHeaders ? formData.getHeaders()['content-type'] : 'multipart/form-data; boundary=...'; // Header includes boundary
					console.warn(
						"Multipart formatting requires specific implementation."
					);
					// For now, return null or throw error
					throw new Error(
						"Multipart formatting not implemented in this basic function."
					);
					break; // Example: Not fully implemented here

				case "xml":
					// COMPLEX: Requires an XML serialization library
					// const xmlString = convertObjectToXml(payload); // Placeholder
					// body = xmlString;
					console.warn(
						"XML formatting requires an external library."
					);
					throw new Error(
						"XML formatting not implemented in this basic function."
					);
					break; // Example: Not fully implemented here

				default:
					console.error(
						`Unsupported requestBodyFormat: ${formatType}`
					);
					// Fallback or throw error
					body = JSON.stringify(payload); // Default to JSON on unknown? Or error?
					contentTypeHeader = "application/json; charset=utf-8";
			}
		} catch (error) {
			console.error(
				`Error formatting request body as ${formatType}:`,
				error
			);
			return { body: null, contentTypeHeader: null }; // Return nulls on error
		}

		return { body, contentTypeHeader };
	}

	/**
	 * Makes an HTTP request using node-fetch.
	 * @param {string} url - The complete URL to request.
	 * @param {string} method - The HTTP method (GET, POST, etc.).
	 * @param {object} headers - The request headers object.
	 * @param {string|Buffer|null|undefined} body - The formatted request body.
	 * @param {number} timeout - Request timeout in milliseconds.
	 * @returns {Promise<{status: number, data: any}>} - Resolves with status and parsed response data.
	 * @throws {Error} If the request fails or returns a non-ok status.
	 */
	async makeHttpRequest(url, options) {
		let controller, timeoutId;
		if (this.server.AbortController) {
			controller = new this.server.AbortController();
			timeoutId = setTimeout(() => controller.abort(), options.timeout);
			options.signal = controller.signal;
		}

		// Remove Content-Type header if there's no body (relevant for GET, DELETE etc.)
		if (
			options.body === undefined &&
			options.headers &&
			options.headers["Content-Type"]
		) {
			delete options.headers["Content-Type"];
		}

		const fetchFn = this.server.fetch || global.fetch;
		if (typeof fetchFn !== "function") {
			throw new Error("No fetch implementation available.");
		}

		try {
			const response = await fetchFn(url, options);
			if (timeoutId) clearTimeout(timeoutId);

			if (!response.ok) {
				const text = await response.text();
				const error = new Error(
					`HTTP error! Status: ${response.status} ${response.statusText}`
				);
				error.response = {
					status: response.status,
					statusText: response.statusText,
					headers: Object.fromEntries(response.headers.entries()),
					data: text
				};
				throw error;
			}
			return response;
		} catch (error) {
			if (timeoutId) clearTimeout(timeoutId);
			throw error;
		}
	}

	async executeScriptWithTimeout(name, data) {
		try {
			if (
				this.modules[name].initialize ||
				this.modules[name].initialize === ""
			) {
				if (data.req) {
					data = await this.webhooks(this.modules[name], data, name);
				} else {
					data = await this.api(this.modules[name], data);
				}
			} else {
				if (!this.modules[name].content) {
					if (this.modules[name].path)
						this.modules[name].content = await require(this.modules[
							name
						].path);
					else {
						try {
							const scriptPath = path.join(
								scriptsDirectory,
								`${name}.js`
							);
							await fs.access(scriptPath);
							this.modules[name].content = await fs.readFile(
								scriptPath,
								"utf8"
							);
						} catch {
							this.modules[name].content =
								await fetchScriptFromDatabaseAndSave(
									name,
									this.modules[name],
									data
								);
						}
					}
				}

				if (this.modules[name].content) {
					data.apis = await this.getApiConfig(data, name);
					data.crud = this.crud;
					data = await this.modules[name].content.send(data);
					delete data.apis;
					delete data.crud;
				} else return;
			}

			if (data.socket) this.wsManager.send(data);

			if (
				this.modules[name].unload === false ||
				this.modules[name].unload === "false"
			)
				return;
			else if (
				this.modules[name].unload === true ||
				this.modules[name].unload === "true"
			)
				console.log("config should unload after completeion ");
			else if (
				(this.modules[name].unload = parseInt(
					this.modules[name].unload,
					10
				))
			) {
				// Check if the script is already loaded
				if (this.modules[name].timeout) {
					clearTimeout(this.modules[name].timeout);
				} else if (!this.modules[name].path) {
					// Execute the script
					this.modules[name].context = new vm.createContext({});
					const script = new vm.Script(this.modules[name].context);
					script.runInContext(context);
				}

				// Reset or set the timeout
				const timeout = setTimeout(() => {
					// delete this.modules[name]
					delete this.modules[name].timeout;
					delete this.modules[name].context;
					delete this.modules[name].content;
					console.log(`Module ${name} removed due to inactivity.`);
					clearModuleCache(name);
				}, this.modules[name].unload);

				this.modules[name].timeout = timeout;
			}
		} catch (error) {
			data.error = error.message;
			if (data.req) {
				data.res.writeHead(400, { "Content-Type": "text/plain" });
				data.res.end(`Lazyload Error: ${error.message}`);
			}
			if (data.socket) this.wsManager.send(data);
		}
	}

	/**
	 * TODO: Implement Enhanced API Configuration Handling
	 *
	 * Description:
	 * - Implement functionality to dynamically handle API configurations, supporting both complete and base URL endpoints with automatic method-based path appending.
	 * - Enable dynamic generation of query parameters from a designated object (`stripe` in the examples) when `query` is true.
	 *
	 * Requirements:
	 * 1. Dynamic Endpoint Handling:
	 *    - Check if the endpoint configuration is a complete URL or a base URL.
	 *    - If the `method` derived path is not already included in the endpoint, append it dynamically.
	 *    Example:
	 *    `{ "method": "stripe.accounts.retrieve", "endpoint": "https://api.stripe.com", "query": true, "stripe": { "acct": "acct_123", "name": "John Doe" } }`
	 *    `{ "method": "stripe.accounts.retrieve", "endpoint": "https://api.stripe.com/accounts/retrieve", "query": true, "stripe": { "acct": "acct_123", "name": "John Doe" } }`
	 *    - Develop logic to parse the `method` and check against the endpoint. If necessary, append the appropriate API method segment.
	 *
	 * 2. Query Parameter Handling:
	 *    - Dynamically construct and append query parameters from the `stripe` object if `query` is true. Ensure proper URL-encoding of keys and values.
	 *
	 * 3. Security:
	 *    - Use the `method` for permission checks, ensuring that each API request complies with security protocols.
	 *
	 * 4. Testing:
	 *    - Test both scenarios where the endpoint may or may not include the method path to ensure the dynamic construction works correctly.
	 *    - Ensure that all query parameters are correctly formatted and appended.
	 *
	 * Notes:
	 * - Consider utility functions for parsing and modifying URLs, as well as for encoding parameters.
	 * - Maintain clear and detailed documentation for each part of the implementation to assist future development and troubleshooting.
	 */

	async api(config, data) {
		try {
			const methodPath = data.method.split(".");
			const name = methodPath.shift();

			const apis = await this.getApiConfig(data, name);

			const key = apis.key;
			if (!key)
				throw new Error(
					`Missing ${name} key in organization apis object`
				);

			// ToDo: if data.endpoint service not required as endpoint will be used
			let instance;

			// Try using require() first, for CommonJS modules
			try {
				instance = require(config.path); // Attempt to require the module
			} catch (err) {
				if (err.code === "ERR_REQUIRE_ESM") {
					// If it's an ESM module, fallback to dynamic import()
					instance = await import(config.path);
				} else {
					throw err; // Re-throw other errors
				}
			}

			if (config.initialize) {
				if (Array.isArray(config.initialize)) {
					const initializations = [];
					for (let i = 0; i < config.initialize.length; i++) {
						const initialize = config.initialize[i].split(".");
						initializations.push(instance);
						// Traverse the nested structure to reach the correct constructor
						for (let j = 0; j < initialize.length; j++) {
							if (initializations[i][initialize[j]]) {
								initializations[i] =
									initializations[i][initialize[j]];
							} else {
								throw new Error(
									`Service path ${config.initialize[i]} is incorrect at ${initialize[j]}`
								);
							}
						}
					}
					instance = new initializations[1](
						new initializations[0](key)
					);
				} else {
					const initialize = config.initialize.split(".");
					// Traverse the nested structure to reach the correct constructor
					for (let i = 0; i < initialize.length; i++) {
						if (instance[initialize[i]]) {
							instance = instance[initialize[i]];
						} else {
							throw new Error(
								`Service path ${config.initialize} is incorrect at ${initialize[i]}`
							);
						}
					}
				}
				// instance = new instance(key);
			}
			// else
			instance = new instance(key);

			let params = [],
				mainParam = false;
			for (let i = 0; true; i++) {
				if (`$param[${i}]` in data[name]) {
					params.push(data[name][`$param[${i}]`]);
					delete data[name][`$param[${i}]`];
				} else if (!mainParam) {
					params.push(data[name]);
					mainParam = true;
				} else {
					break;
				}
			}

			// TODO: should run processOperators before in order to perform complex opertions and get data, will need to loop back on permission in order to authenticate and autorize
			// data[name] = await processOperators(data, null, data[name]);

			// data[name] = await processOperators(data, null, data[name]);

			// execute = await this.processOperators(data, event, execute);

			data[name] = await executeMethod(
				data.method,
				methodPath,
				instance,
				params
			);

			// TODO: should run processOperators after in order to perform complex opertions and get data
			// data[name] = await processOperators(data, data[name]);

			return data;
		} catch (error) {
			data.error = error.message;
			return data;
		}
	}

	async webhooks(config, data, name) {
		try {
			const apis = await this.getApiConfig(data, name);

			const key = apis.key;
			if (!key)
				throw new Error(
					`Missing ${name} key in organization apis object`
				);

			let webhookName = data.req.url.split("/");
			webhookName = webhookName[webhookName.length - 1];

			const webhook = apis.webhooks[webhookName];
			if (!webhook)
				throw new Error(
					`Webhook ${name} ${webhookName} is not defined`
				);

			// eventDataKey is used to access the event data
			let eventDataKey = webhook.eventDataKey || apis.eventDataKey;
			if (!eventDataKey)
				throw new Error(`Webhook ${name} eventKey is not defined`);

			// eventNameKey is used to access the event the event name
			let eventNameKey = webhook.eventNameKey || apis.eventNameKey;
			if (!eventNameKey)
				throw new Error(`Webhook ${name} eventNameKey is not defined`);

			if (!webhook.events)
				throw new Error(`Webhook ${name} events are not defined`);

			data.rawBody = "";
			await new Promise((resolve, reject) => {
				data.req.on("data", (chunk) => {
					data.rawBody += chunk.toString();
				});
				data.req.on("end", () => {
					resolve();
				});
				data.req.on("error", (err) => {
					reject(err);
				});
			});

			let parameters, method;

			if (webhook.authenticate && webhook.authenticate.method) {
				method = webhook.authenticate.method;
			} else if (apis.authenticate && apis.authenticate.method) {
				method = apis.authenticate.method;
			} else
				throw new Error(
					`Webhook ${name} authenticate method is not defined`
				);

			if (webhook.authenticate && webhook.authenticate.parameters) {
				parameters = webhook.authenticate.parameters;
			} else if (apis.authenticate && apis.authenticate.parameters) {
				parameters = apis.authenticate.parameters;
			} else
				throw new Error(
					`Webhook ${name} authenticate parameters is not defined`
				);

			// TODO: webhook secert could be a key pair

			let event;
			if (!method) {
				if (!parameters[0] !== parameters[1])
					throw new Error(
						`Webhook secret failed for ${name}. Unauthorized access attempt.`
					);

				event = JSON.parse(data.rawBody);
			} else {
				const service = require(config.path);
				let instance;
				if (config.initialize)
					instance = new service[config.initialize](key);
				else instance = new service(key);

				const methodPath = method.split(".");

				await this.processOperators(data, "", parameters);

				event = await executeMethod(
					method,
					methodPath,
					instance,
					parameters
				);
			}

			let eventName = getValueFromObject(event, eventNameKey);
			if (!eventName)
				throw new Error(
					`Webhook ${name} eventNameKey: ${eventNameKey} could not be found in the event.`
				);

			let eventData = getValueFromObject(event, eventDataKey);
			if (!eventData)
				throw new Error(
					`Webhook ${name} eventDataKey: ${eventDataKey} could not be found in the event.`
				);

			let execute = webhook.events[eventName];
			if (execute) {
				execute = await this.processOperators(data, event, execute);
			}

			data.res.writeHead(200, { "Content-Type": "application/json" });
			data.res.end(
				JSON.stringify({ message: "Webhook received and processed" })
			);
			return data;
		} catch (error) {
			data.error = error.message;
			data.res.writeHead(400, { "Content-Type": "text/plain" });
			data.res.end(error.message);
			return data;
		}
	}

	async processOperators(data, event, execute) {
		if (Array.isArray(execute)) {
			for (let index = 0; index < execute.length; index++) {
				execute[index] = await this.processOperators(
					data,
					event,
					execute[index]
				);
			}
		} else if (typeof execute === "object" && execute !== null) {
			for (let key of Object.keys(execute)) {
				if (
					key.startsWith("$") &&
					!["$storage", "$database", "$array", "$filter"].includes(
						key
					)
				) {
					execute[key] = await this.processOperator(
						data,
						event,
						key,
						execute[key]
					);
				} else if (
					typeof execute[key] === "string" &&
					execute[key].startsWith("$") &&
					!["$storage", "$database", "$array", "$filter"].includes(
						execute[key]
					)
				) {
					execute[key] = await this.processOperator(
						data,
						event,
						execute[key]
					);
				} else if (Array.isArray(execute[key])) {
					execute[key] = await this.processOperators(
						data,
						event,
						execute[key]
					);
				} else if (
					typeof execute[key] === "object" &&
					execute[key] !== null
				) {
					execute[key] = await this.processOperators(
						data,
						event,
						execute[key]
					);
				}
			}
		} else if (
			typeof execute === "string" &&
			execute.startsWith("$") &&
			!["$storage", "$database", "$array", "$filter"].includes(execute)
		) {
			execute = await this.processOperator(data, event, execute);
		}

		return execute;
	}

	async processOperator(data, event, operator, context) {
		let result;
		if (operator.startsWith("$data.")) {
			result = getValueFromObject(data, operator.substring(6));
			return getValueFromObject(data, operator.substring(6));
		} else if (operator.startsWith("$req")) {
			return getValueFromObject(data, operator.substring(1));
		} else if (operator.startsWith("$header")) {
			return getValueFromObject(data.req, operator.substring(1));
		} else if (operator.startsWith("$rawBody")) {
			return getValueFromObject(data, operator.substring(1));
		} else if (operator.startsWith("$crud")) {
			let results = context;
			let isObject = false;
			if (!Array.isArray(results)) {
				isObject = true;
				results = [results];
			}

			for (let i = 0; i < results.length; i++) {
				results[i] = await this.processOperators(
					data,
					event,
					results[i]
				);
				results[i] = await this.crud.send(results[i]);
				if (operator.startsWith("$crud."))
					results[i] = getValueFromObject(
						operator,
						operator.substring(6)
					);
				results[i] = await this.processOperators(
					data,
					event,
					results[i]
				);
			}

			if (isObject) results = results[0];

			return results;
		} else if (operator.startsWith("$socket")) {
			context = await this.processOperators(data, event, context);
			result = await this.socket.send(context);
			if (operator.startsWith("$socket."))
				result = getValueFromObject(operator, operator.substring(6));
			return await this.processOperators(data, event, result);
		} else if (operator.startsWith("$api")) {
			context = await this.processOperators(data, event, context);
			let name = context.method.split(".")[0];
			result = this.executeScriptWithTimeout(name, context);
			if (operator.startsWith("$api."))
				result = getValueFromObject(event, operator.substring(5));
			return await this.processOperators(data, event, result);
		} else if (operator.startsWith("$event")) {
			if (operator.startsWith("$event."))
				result = getValueFromObject(event, operator.substring(7));
			return await this.processOperators(data, event, result);
		}

		return operator;
	}

	async getApiConfig(data, name) {
		let organization = await this.crud.getOrganization(data);
		if (organization.error) throw new Error(organization.error);
		if (!organization.apis)
			throw new Error("Missing apis object in organization object");
		if (!organization.apis[name])
			throw new Error(`Missing ${name} in organization apis object`);
		return organization.apis[name];
	}
}

async function executeMethod(method, methodPath, instance, params) {
	try {
		switch (methodPath.length) {
			case 1:
				return await instance[methodPath[0]](...params);
			case 2:
				return await instance[methodPath[0]][methodPath[1]](...params);
			case 3:
				return await instance[methodPath[0]][methodPath[1]][
					methodPath[2]
				](...params);
			case 4:
				return await instance[methodPath[0]][methodPath[1]][
					methodPath[2]
				][methodPath[3]](...params);
			case 5:
				return await instance[methodPath[0]][methodPath[1]][
					methodPath[2]
				][methodPath[3]][methodPath[4]](...params);
			case 6:
				return await instance[methodPath[0]][methodPath[1]][
					methodPath[2]
				][methodPath[3]][methodPath[4]][methodPath[5]](...params);
			case 7:
				return await instance[methodPath[0]][methodPath[1]][
					methodPath[2]
				][methodPath[3]][methodPath[4]][methodPath[5]][methodPath[6]](
					...params
				);
			case 8:
				return await instance[methodPath[0]][methodPath[1]][
					methodPath[2]
				][methodPath[3]][methodPath[4]][methodPath[5]][methodPath[6]][
					methodPath[7]
				](...params);
			default:
				const methodName = methodPath.pop();
				let Method = instance;
				for (let i = 0; i < methodPath.length; i++) {
					Method = Method[methodPath[i]];
					if (Method === undefined) {
						throw new Error(
							`Method ${methodPath[i]} not found using ${method}.`
						);
					}
				}

				if (typeof Method[methodName] !== "function")
					throw new Error(`Method ${method} is not a function.`);

				return await Method[methodName](...params);
		}
	} catch (error) {
		throw new Error(error);
	}
}

function getModuleDependencies(modulePath) {
	let moduleObj = require.cache[modulePath];
	if (!moduleObj) {
		return [];
	}

	// Get all child module paths
	return moduleObj.children.map((child) => child.id);
}

function isModuleUsedElsewhere(modulePath, name) {
	return Object.keys(require.cache).some((path) => {
		const moduleObj = require.cache[path];
		// return moduleObj.children.some(child => child.id === modulePath && path !== modulePath);
		return moduleObj.children.some((child) => {
			// let test = child.id === modulePath && path !== modulePath
			// if (test)
			//     return test
			return child.id === modulePath && path !== modulePath;
		});
	});
}

function clearModuleCache(name) {
	try {
		const modulePath = require.resolve(name);
		const dependencies = getModuleDependencies(modulePath);

		// Check if the module is a dependency of other modules
		// const moduleObj = require.cache[modulePath];
		// if (moduleObj && moduleObj.parent) {
		//     console.log(`Module ${name} is a dependency of other modules.`);
		//     return;
		// }

		// Check if the module is used by other modules
		if (isModuleUsedElsewhere(modulePath, name)) {
			console.log(`Module ${name} is a dependency of other modules.`);
			return;
		}

		// Remove the module from the cache
		delete require.cache[modulePath];
		console.log(`Module ${name} has been removed from cache.`);
		// Recursively clear dependencies from cache
		dependencies.forEach((depPath) => {
			clearModuleCache(depPath);
		});
	} catch (error) {
		console.error(
			`Error clearing module cache for ${name}: ${error.message}`
		);
	}
}

// Function to fetch script from database and save to disk
async function fetchScriptFromDatabaseAndSave(name, moduleConfig) {
	let data = {
		method: "object.read",
		host: moduleConfig.object.hostname,
		array: moduleConfig.array,
		$filter: {
			query: {
				host: { $in: [moduleConfig.object.hostname, "*"] },
				pathname: moduleConfig.object.pathname
			},
			limit: 1
		},
		organization_id
	};

	let file = await this.crud.send(data);
	let src;

	if (file && file.object && file.object[0]) {
		src = file.object[0].src;
	} else {
		throw new Error("Script not found in database");
	}

	// Save to disk for future use
	const scriptPath = path.join(scriptsDirectory, `${name}.js`);
	await fs.writeFile(scriptPath, src);

	return src;
}

module.exports = CoCreateLazyLoader;
