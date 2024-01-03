const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');
const Config = require("@cocreate/config");
const { URL } = require('url');

const organizations = {};
const hosts = {};

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
            await fs.access(directory);
            console.log("The directory exists.");
        } catch (error) {
            try {
                await fs.mkdir(scriptsDirectory, { recursive: true });
                console.log(`Scripts directory created at ${scriptsDirectory}`);
            } catch (error) {
                console.error('Error creating scripts directory:', error);
                throw error; // Halt execution if directory creation fails
            }
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

            let organization = hosts[hostname];
            if (!organization) {
                let org = await this.crud.send({
                    method: 'object.read',
                    array: 'organizations',
                    $filter: {
                        query: [
                            { key: "host", value: [hostname], operator: "$in" }
                        ]
                    },
                    organization_id: process.env.organization_id
                })

                if (!org || !org.object || !org.object[0]) {
                    // TODO: hostNotFound is not defined
                    if (!hostNotFound)
                        hostNotFound = await getDefaultFile('/hostNotFound.html')
                    return sendResponse(hostNotFound.object[0].src, 404, { 'Content-Type': 'text/html', 'storage': organization.storage })
                } else {
                    organization = org.object[0]
                    organizations[organization._id] = organization
                }
            }

            hosts[hostname] = organization

            if (valideUrl.pathname.startsWith('/webhooks/')) {
                let name = req.url.split('/')[2]; // Assuming URL structure is /webhook/name/...
                if (this.modules[name]) {
                    this.executeScriptWithTimeout(name, { req, res, organization, valideUrl, organization_id: organization._id })
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
                data.apis = await this.getApiKey(data.organization_id, name)
                data.crud = this.crud
                data = await this.modules[name].content.send(data)
                delete data.apis
                delete data.crud
                if (data.socket)
                    this.wsManager.send(data)
            } else
                return

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
            console.log(error)
        }
    }

    async getApiKey(organization_id, name) {
        organizations[organization_id] = this.getOrganization(organization_id, name)
        organizations[organization_id] = await organizations[organization_id]
        return organizations[organization_id][name]
    }

    async getOrganization(organization_id) {
        let organization = await this.crud.send({
            method: 'object.read',
            database: organization_id,
            array: 'organizations',
            object: [{ _id: organization_id }],
            organization_id
        })

        if (organization
            && organization.object
            && organization.object[0]) {
            if (organization.object[0].apis) {
                return organization.object[0].apis
            } else
                return { error: 'No apis defined could not be found' }
        } else {
            return { serverOrganization: false, error: 'An organization could not be found' }
        }

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
        array: moduleConfig.array,
        $filter: {
            query: [
                { key: "host", value: [moduleConfig.object.hostname, '*'], operator: "$in" },
                { key: "pathname", value: moduleConfig.object.pathname, operator: "$eq" }
            ],
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