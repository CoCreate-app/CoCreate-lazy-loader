const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const vm = require('vm');
const Config = require("@cocreate/config");
const { getValueFromObject } = require('@cocreate/utils');


class CoCreateLazyLoader {
    constructor(server, crud, files) {
        this.server = server
        this.wsManager = crud.wsManager
        this.crud = crud
        this.files = files
        this.exclusion = { ...require.cache };
        this.modules = {};
        this.init()
    }

    async init() {
        const scriptsDirectory = './scripts';

        try {
            await fs.mkdir(scriptsDirectory, { recursive: true });
        } catch (error) {
            console.error('Error creating scripts directory:', error);
            throw error; // Halt execution if directory creation fails
        }

        this.modules = await Config('modules', false, false)
        if (!this.modules)
            return
        else
            this.modules = this.modules.modules

        for (let name of Object.keys(this.modules)) {
            this.wsManager.on(this.modules[name].event, async (data) => {
                this.executeScriptWithTimeout(name, data)
            });
        }

        this.server.https.on('request', (req, res) => this.request(req, res))
        this.server.http.on('request', (req, res) => this.request(req, res))

    }

    async request(req, res) {
        try {
            // TODO: track usage
            const valideUrl = new URL(`http://${req.headers.host}${req.url}`);
            const hostname = valideUrl.hostname;
            let organization

            try {
                organization = await this.crud.getOrganization({ host: hostname });
            } catch {
                return this.files.send(req, res, this.crud, organization, valideUrl)
            }

            if (valideUrl.pathname.startsWith('/webhooks/')) {
                let name = req.url.split('/')[2]; // Assuming URL structure is /webhook/name/...
                if (this.modules[name]) {
                    this.executeScriptWithTimeout(name, { req, res, host: hostname, organization, valideUrl, organization_id: organization._id })
                } else {
                    // Handle unknown module or missing webhook method
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Not found' }));
                }

            } else {
                this.files.send(req, res, this.crud, organization, valideUrl)
            }

        } catch (error) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid host format');
        }
    }

    async executeScriptWithTimeout(name, data) {
        try {
            if (this.modules[name].initialize || this.modules[name].initialize === '') {
                if (data.req)
                    data = await this.webhooks(this.modules[name], data, name)
                else
                    data = await this.api(this.modules[name], data)
            } else {
                if (!this.modules[name].content) {
                    if (this.modules[name].path)
                        this.modules[name].content = await require(this.modules[name].path)
                    else {
                        try {
                            const scriptPath = path.join(scriptsDirectory, `${name}.js`);
                            await fs.access(scriptPath);
                            this.modules[name].content = await fs.readFile(scriptPath, 'utf8');
                        } catch {
                            this.modules[name].content = await fetchScriptFromDatabaseAndSave(name, this.modules[name], data);
                        }
                    }
                }

                if (this.modules[name].content) {
                    data.apis = await this.getApiKey(data, name)
                    data.crud = this.crud
                    data = await this.modules[name].content.send(data)
                    delete data.apis
                    delete data.crud
                } else
                    return
            }

            if (data.socket)
                this.wsManager.send(data)

            if (this.modules[name].unload === false || this.modules[name].unload === 'false')
                return
            else if (this.modules[name].unload === true || this.modules[name].unload === 'true')
                console.log('config should unload after completeion ')
            else if (this.modules[name].unload = parseInt(this.modules[name].unload, 10)) {
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
                    delete this.modules[name].timeout
                    delete this.modules[name].context
                    delete this.modules[name].content
                    console.log(`Module ${name} removed due to inactivity.`);
                    clearModuleCache(name);

                }, this.modules[name].unload);

                this.modules[name].timeout = timeout
            }
        } catch (error) {
            data.error = error.message
            if (data.req) {
                data.res.writeHead(400, { 'Content-Type': 'text/plain' });
                data.res.end(`Lazyload Error: ${error.message}`);
            } if (data.socket)
                this.wsManager.send(data)
        }
    }

    async api(config, data) {
        try {
            const methodPath = data.method.split('.')
            const name = methodPath.shift()

            const apis = await this.getApiKey(data, name)
            let environment = 'production';

            if (data.environment)
                environment = data.environment
            else if (data.host.startsWith('dev.') || data.host.startsWith('test.'))
                environment = 'test'

            const key = apis[environment].key;
            if (!key)
                throw new Error(`Missing ${name} key in organization apis object`);

            const service = require(config.path);
            let instance
            if (config.initialize)
                instance = new service[config.initialize](key);
            else
                instance = new service(key);

            let params = [], mainParam = false
            for (let i = 0; true; i++) {
                if (`$param[${i}]` in data[name]) {
                    params.push(data[name][`$param[${i}]`])
                    delete data[name][`$param[${i}]`]
                } else if (!mainParam) {
                    params.push(data[name])
                    mainParam = true
                } else {
                    break;
                }
            }

            // TODO: should run processOperators before in order to perform complex opertions and get data
            // data[name] = await processOperators(data, null, data[name]);

            data[name] = await executeMethod(data.method, methodPath, instance, params)

            // TODO: should run processOperators after in order to perform complex opertions and get data
            // data[name] = await processOperators(data, data[name]);

            return data
        } catch (error) {
            data.error = error.message
            return data
        }
    }

    async webhooks(config, data, name) {
        try {
            const apis = await this.getApiKey(data, name)
            if (data.environment)
                environment = data.environment
            else if (data.host.startsWith('dev.') || data.host.startsWith('test.'))
                environment = 'test'

            const key = apis[environment].key;
            if (!key)
                throw new Error(`Missing ${name} key in organization apis object`);

            let webhookName = data.req.url.split('/');
            webhookName = webhookName[webhookName.length - 1]

            const webhook = apis[environment].webhooks[webhookName];
            if (!webhook)
                throw new Error(`Webhook ${name} ${webhookName} is not defined`);

            // eventDataKey is used to access the event data
            let eventDataKey = webhook.eventDataKey || apis[environment].eventDataKey
            if (!eventDataKey)
                throw new Error(`Webhook ${name} eventKey is not defined`);

            // eventNameKey is used to access the event the event name
            let eventNameKey = webhook.eventNameKey || apis[environment].eventNameKey
            if (!eventNameKey)
                throw new Error(`Webhook ${name} eventNameKey is not defined`);

            if (!webhook.events)
                throw new Error(`Webhook ${name} events are not defined`);

            data.rawBody = '';
            await new Promise((resolve, reject) => {
                data.req.on('data', chunk => {
                    data.rawBody += chunk.toString();
                });
                data.req.on('end', () => {
                    resolve();
                });
                data.req.on('error', (err) => {
                    reject(err);
                });
            });

            let parameters, method


            if (webhook.authenticate && webhook.authenticate.method) {
                method = webhook.authenticate.method
            } else if (apis[environment].authenticate && apis[environment].authenticate.method) {
                method = apis[environment].authenticate.method
            } else
                throw new Error(`Webhook ${name} authenticate method is not defined`);

            if (webhook.authenticate && webhook.authenticate.parameters) {
                parameters = webhook.authenticate.parameters
            } else if (apis[environment].authenticate && apis[environment].authenticate.parameters) {
                parameters = apis[environment].authenticate.parameters
            } else
                throw new Error(`Webhook ${name} authenticate parameters is not defined`);

            // TODO: webhook secert could be a key pair

            let event
            if (!method) {
                if (!parameters[0] !== parameters[1])
                    throw new Error(`Webhook secret failed for ${name}. Unauthorized access attempt.`);

                event = JSON.parse(data.rawBody)
            } else {
                const service = require(config.path);
                let instance
                if (config.initialize)
                    instance = new service[config.initialize](key);
                else
                    instance = new service(key);

                const methodPath = method.split('.')

                await this.processOperators(data, '', parameters);

                event = await executeMethod(method, methodPath, instance, parameters)
            }

            let eventName = getValueFromObject(event, eventNameKey)
            if (!eventName)
                throw new Error(`Webhook ${name} eventNameKey: ${eventNameKey} could not be found in the event.`);

            let eventData = getValueFromObject(event, eventDataKey)
            if (!eventData)
                throw new Error(`Webhook ${name} eventDataKey: ${eventDataKey} could not be found in the event.`);

            let execute = webhook.events[eventName];
            if (execute) {
                execute = await this.processOperators(data, event, execute);
            }

            data.res.writeHead(200, { 'Content-Type': 'application/json' });
            data.res.end(JSON.stringify({ message: 'Webhook received and processed' }));
            return data
        } catch (error) {
            data.error = error.message
            data.res.writeHead(400, { 'Content-Type': 'text/plain' });
            data.res.end(error.message);
            return data
        }
    }

    async processOperators(data, event, execute, parent = null, parentKey = null) {
        if (Array.isArray(execute)) {
            for (let index = 0; index < execute.length; index++) {
                execute[index] = await this.processOperators(data, event, execute[index], execute, index);
            }
        } else if (typeof execute === 'object' && execute !== null) {
            for (let key of Object.keys(execute)) {
                if (key.startsWith('$')) {
                    const operatorResult = await this.processOperator(data, event, key, execute[key]);
                    if (parent && operatorResult !== null && parentKey !== null) {
                        parent[parentKey] = operatorResult;
                        await this.processOperators(data, event, parent[parentKey], parent, parentKey);
                    }
                } else {
                    execute[key] = await this.processOperators(data, event, execute[key], execute, key);
                }
            }
        } else {
            return await this.processOperator(data, event, execute);
        }
        return execute;
    }

    async processOperator(data, event, operator, context) {
        let result
        if (operator.startsWith('$data.')) {
            return getValueFromObject(data, operator.substring(6))
        } else if (operator.startsWith('$req')) {
            return getValueFromObject(data, operator.substring(1))
        } else if (operator.startsWith('$header')) {
            return getValueFromObject(data.req, operator.substring(1))
        } else if (operator.startsWith('$rawBody')) {
            return getValueFromObject(data, operator.substring(1))
        } else if (operator.startsWith('$crud')) {
            context = await this.processOperators(data, event, context);
            result = await this.crud.send(context)
            if (operator.startsWith('$crud.'))
                result = getValueFromObject(operator, operator.substring(6))
            return await this.processOperators(data, event, result);
        } else if (operator.startsWith('$socket')) {
            context = await this.processOperators(data, event, context);
            result = await this.socket.send(context)
            if (operator.startsWith('$socket.'))
                result = getValueFromObject(operator, operator.substring(6))
            return await this.processOperators(data, event, result);
        } else if (operator.startsWith('$api')) {
            context = await this.processOperators(data, event, context);
            let name = context.method.split('.')[0]
            result = this.executeScriptWithTimeout(name, context)
            if (operator.startsWith('$api.'))
                result = getValueFromObject(event, operator.substring(5))
            return await this.processOperators(data, event, result);
        } else if (operator.startsWith('$event')) {
            if (operator.startsWith('$event.'))
                result = getValueFromObject(event, operator.substring(7))
            return await this.processOperators(data, event, result);
        }

        return operator;
    }

    async getApiKey(data, name) {
        let organization = await this.crud.getOrganization(data);
        if (organization.error)
            throw new Error(organization.error);
        if (!organization.apis)
            throw new Error('Missing apis object in organization object');
        if (!organization.apis[name])
            throw new Error(`Missing ${name} in organization apis object`);
        return organization.apis[name]
    }

}


// async function processOperators(data, event, execute, parent = null, parentKey = null) {
//     if (Array.isArray(execute)) {
//         execute.forEach(async (item, index) => await processOperators(data, event, item, execute, index));
//     } else if (typeof execute === 'object' && execute !== null) {
//         for (let key of Object.keys(execute)) {
//             // Check if key is an operator
//             if (key.startsWith('$')) {
//                 const operatorResult = await processOperator(data, event, key, execute[key]);
//                 if (parent && operatorResult !== null) {
//                     if (parentKey !== null) {
//                         parent[parentKey] = operatorResult;
//                         await processOperators(data, event, parent[parentKey], parent, parentKey);
//                     }
//                     // else {
//                     //     // Scenario 2: Replace the key (more complex, might require re-structuring the executable object)
//                     //     delete parent[key]; // Remove the original key
//                     //     parent[operatorResult] = execute[key]; // Assign the value to the new key
//                     //     // Continue processing the new key if necessary
//                     // }
//                 }
//             } else {
//                 await processOperators(data, event, execute[key], execute, key);
//             }
//         }
//     } else {
//         return await processOperator(data, event, execute);
//     }
// }

async function executeMethod(method, methodPath, instance, params) {
    try {
        switch (methodPath.length) {
            case 1:
                return await instance[methodPath[0]](...params)
            case 2:
                return await instance[methodPath[0]][methodPath[1]](...params);
            case 3:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]](...params);
            case 4:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]](...params);
            case 5:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]][methodPath[4]](...params);
            case 6:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]][methodPath[4]][methodPath[5]](...params);
            case 7:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]][methodPath[4]][methodPath[5]][methodPath[6]](...params);
            case 8:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]][methodPath[4]][methodPath[5]][methodPath[6]][methodPath[7]](...params);
            default:
                const methodName = methodPath.pop();
                let Method = instance
                for (let i = 0; i < methodPath.length; i++) {
                    Method = Method[methodPath[i]]
                    if (Method === undefined) {
                        throw new Error(`Method ${methodPath[i]} not found using ${method}.`);
                    }
                }

                if (typeof Method[methodName] !== 'function')
                    throw new Error(`Method ${method} is not a function.`);

                return await Method[methodName](...params)
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
    return moduleObj.children.map(child => child.id);
}

function isModuleUsedElsewhere(modulePath, name) {
    return Object.keys(require.cache).some(path => {
        const moduleObj = require.cache[path];
        // return moduleObj.children.some(child => child.id === modulePath && path !== modulePath);
        return moduleObj.children.some(child => {
            // let test = child.id === modulePath && path !== modulePath
            // if (test)
            //     return test
            return child.id === modulePath && path !== modulePath
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
        dependencies.forEach(depPath => {
            clearModuleCache(depPath);
        });

    } catch (error) {
        console.error(`Error clearing module cache for ${name}: ${error.message}`);
    }
}

// Function to fetch script from database and save to disk
async function fetchScriptFromDatabaseAndSave(name, moduleConfig) {
    let data = {
        method: 'object.read',
        host: moduleConfig.object.hostname,
        array: moduleConfig.array,
        $filter: {
            query: {
                host: { $in: [moduleConfig.object.hostname, '*'] },
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
        throw new Error('Script not found in database');
    }

    // Save to disk for future use
    const scriptPath = path.join(scriptsDirectory, `${name}.js`);
    await fs.writeFile(scriptPath, src);

    return src;
}




module.exports = CoCreateLazyLoader;