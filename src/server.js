const EventEmitter = require('events');
const eventEmitter = new EventEmitter();
const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');
const Config = require("@cocreate/config");

class CoCreateLazyLoader {
    constructor(crud) {
        this.wsManager = crud.wsManager
        this.crud = crud
        this.exclusion = { ...require.cache };
        this.modules = {};
        this.init()
    }

    async init() {
        // Function to create the scripts directory if it doesn't exist
        async function createScriptsDirectory() {
            try {
                const scriptsDirectory = './scripts';
                await fs.mkdir(scriptsDirectory, { recursive: true });
                console.log(`Scripts directory created at ${scriptsDirectory}`);
            } catch (error) {
                console.error('Error creating scripts directory:', error);
                throw error; // Halt execution if directory creation fails
            }
        }

        // Call this function at the start of your application
        createScriptsDirectory();

        const config = await Config('lazyload', false, false)
        if (!config)
            return

        for (let key of Object.keys(config.lazyload)) {
            let moduleConfig = config.lazyload[key];
            eventEmitter.on(moduleConfig.event, async () => {
                this.executeScriptWithTimeout(key, moduleConfig)
            });
        }

        // eventEmitter.emit('openai');

    }

    async executeScriptWithTimeout(moduleName, moduleConfig) {
        try {
            if (!moduleConfig.content) {
                if (moduleConfig.path)
                    moduleConfig.content = await require(moduleConfig.path)
                else {
                    try {
                        const scriptPath = path.join(scriptsDirectory, `${moduleName}.js`);
                        await fs.access(scriptPath);
                        moduleConfig.content = await fs.readFile(scriptPath, 'utf8');
                    } catch {
                        moduleConfig.content = await fetchScriptFromDatabaseAndSave(moduleName, moduleConfig);
                    }
                }
            }

            if (moduleConfig.unload === false || moduleConfig.unload === 'false')
                return
            else if (moduleConfig.unload === true || moduleConfig.unload === 'true')
                console.log('config should unload after completeion ')
            else if (moduleConfig.unload = parseInt(moduleConfig.unload, 10)) {
                // Check if the script is already loaded
                if (moduleConfig.timeout) {
                    clearTimeout(moduleConfig.timeout);
                } else if (!moduleConfig.path) {
                    // Execute the script
                    moduleConfig.context = new vm.createContext({});
                    const script = new vm.Script(moduleConfig.context);
                    script.runInContext(context);
                }

                // Reset or set the timeout
                const timeout = setTimeout(() => {
                    delete this.modules[moduleName]
                    delete moduleConfig.timeout
                    delete moduleConfig.context
                    delete moduleConfig.content
                    console.log(`Module ${moduleName} removed due to inactivity.`);
                    clearModuleCache(moduleName);

                }, moduleConfig.unload);

                moduleConfig.timeout = timeout
            }
        } catch (error) {
            console.log(error)
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

function isModuleUsedElsewhere(modulePath, moduleName) {
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

function clearModuleCache(moduleName) {
    try {
        const modulePath = require.resolve(moduleName);
        const dependencies = getModuleDependencies(modulePath);

        // Check if the module is a dependency of other modules
        // const moduleObj = require.cache[modulePath];
        // if (moduleObj && moduleObj.parent) {
        //     console.log(`Module ${moduleName} is a dependency of other modules.`);
        //     return;
        // }

        // Check if the module is used by other modules
        if (isModuleUsedElsewhere(modulePath, moduleName)) {
            console.log(`Module ${moduleName} is a dependency of other modules.`);
            return;
        }

        // Remove the module from the cache
        delete require.cache[modulePath];
        console.log(`Module ${moduleName} has been removed from cache.`);
        // Recursively clear dependencies from cache
        dependencies.forEach(depPath => {
            clearModuleCache(depPath);
        });

    } catch (error) {
        console.error(`Error clearing module cache for ${moduleName}: ${error.message}`);
    }
}

// Function to fetch script from database and save to disk
async function fetchScriptFromDatabaseAndSave(moduleName, moduleConfig) {
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

    let file = await crud.send(data);
    let src;

    if (file && file.object && file.object[0]) {
        src = file.object[0].src;
    } else {
        throw new Error('Script not found in database');
    }

    // Save to disk for future use
    const scriptPath = path.join(scriptsDirectory, `${moduleName}.js`);
    await fs.writeFile(scriptPath, src);

    return src;
}

module.exports = CoCreateLazyLoader;