const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');
const Config = require("@cocreate/config");
const { URL } = require('url');

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
            if (this.modules[name].initialize) {
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
            const environment = data.environment || 'production';
            const key = apis[environment].key;
            if (!key)
                throw new Error(`Missing ${name} key in organization apis object`);

            const service = require(config.path);
            const instance = new service[config.initialize](key);

            let method = instance
            for (let i = 0; i < methodPath.length; i++) {
                method = method[methodPath[i]]
                if (method === undefined) {
                    throw new Error(`Method ${methodPath[i]} not found using ${data.method}.`);
                }
            }

            if (typeof method !== 'function')
                throw new Error(`Method ${data.method} is not a function.`);

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

            data.postmark = await method.apply(instance, params);
            return data
        } catch (error) {
            data.error = error.message
            return data
        }
    }

    async webhooks(config, data, name) {
        try {
            const apis = await this.getApiKey(data, name)
            let environment = data.environment || 'production';
            if (data.host.startsWith('dev.') || data.host.startsWith('test.'))
                environment = 'test'

            const key = apis[environment].key;
            if (!key)
                throw new Error(`Missing ${name} key in organization apis object`);

            let name = data.req.url.split('/');
            name = name[3] || name[2] || name[1]

            // TODO: webhook secert could be a key pair
            const webhookSecret = data.apis[environment].webhooks[name];
            if (webhookSecret !== req.headers[name])
                throw new Error(`Webhook secret failed for ${name}. Unauthorized access attempt.`);

            let rawBody = '';
            await new Promise((resolve, reject) => {
                data.req.on('data', chunk => {
                    rawBody += chunk.toString();
                });
                data.req.on('end', () => {
                    resolve();
                });
                data.req.on('error', (err) => {
                    reject(err);
                });
            });

            // TODO: if decrypt and validation is builtin to service   
            // const service = require(config.path);
            // const instance = new service[config.initialize](key);

            // TODO: event may need to be handle by a built in service function
            const event = JSON.parse(rawBody)
            // TODO: using request.method and event.type get object and send socket.onMessage for proccessing

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