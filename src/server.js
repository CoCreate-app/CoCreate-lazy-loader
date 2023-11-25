const EventEmitter = require('events');
const eventEmitter = new EventEmitter();
const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');

const scriptsDirectory = './scripts';

class CoCreateLazyLoader {
    constructor(crud) {
        this.wsManager = crud.wsManager
        this.crud = crud
        this.init()
    }

    init() {
        // TODO: check CoCreate.config.js  using config 
        const lazyLoadConfig = Config('lazyload')
        if (!lazyLoadConfig)
            return

        for (let key of Object.keys(lazyLoadConfig.lazyload)) {
            let moduleConfig = lazyLoadConfig.lazyload[key];
            eventEmitter.on(moduleConfig.event, async () => {
                try {
                    const module = await require(moduleConfig.path);

                    if (typeof moduleConfig.unload === 'number') {
                        setTimeout(() => {
                            // Implement module unload logic
                        }, moduleConfig.unload);
                    }

                    // Use openaiModule here

                } catch (error) {
                    console.log()
                }
            });

            console.log("Module Key:", key);
            console.log("Module Config:", moduleConfig);

        }

    }
}

// Emitting the event somewhere in your application
// eventEmitter.emit('openai');

let exclusion = {};

function generateExclusionList() {
    exclusion = { ...require.cache };
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
        return moduleObj.children.some(child => child.id === modulePath && path !== modulePath);
    });
}

function clearModuleCache(moduleName) {
    try {
        const modulePath = require.resolve(moduleName);
        const dependencies = getModuleDependencies(modulePath);

        // Recursively clear dependencies from cache
        dependencies.forEach(depPath => {
            clearModuleCache(depPath);
        });

        // Check if the module is a dependency of other modules
        const moduleObj = require.cache[modulePath];
        if (moduleObj && moduleObj.parent) {
            console.log(`Module ${moduleName} is a dependency of other modules.`);
            return;
        }

        // Check if the module is used by other modules
        if (isModuleUsedElsewhere(modulePath, moduleName)) {
            console.log(`Module ${moduleName} is a dependency of other modules.`);
            return;
        }

        // Remove the module from the cache
        delete require.cache[modulePath];
        console.log(`Module ${moduleName} has been removed from cache.`);
    } catch (error) {
        console.error(`Error clearing module cache for ${moduleName}: ${error.message}`);
    }
}

// Function to create the scripts directory if it doesn't exist
async function createScriptsDirectory() {
    try {
        await fs.mkdir(scriptsDirectory, { recursive: true });
        console.log(`Scripts directory created at ${scriptsDirectory}`);
    } catch (error) {
        console.error('Error creating scripts directory:', error);
        throw error; // Halt execution if directory creation fails
    }
}

// Call this function at the start of your application
createScriptsDirectory();

// Function to fetch script from database and save to disk
async function fetchScriptFromDatabaseAndSave(scriptId, pathname) {
    let data = {
        method: 'object.read',
        array: 'files',
        $filter: {
            query: [
                { key: "host", value: [hostname, '*'], operator: "$in" },
                { key: "pathname", value: pathname, operator: "$eq" }
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
    const scriptPath = path.join(scriptsDirectory, `${scriptId}.js`);
    await fs.writeFile(scriptPath, src);

    return src;
}

// Map to track timeouts and contexts for each script
const scriptTimeouts = new Map();

// Function to execute a script with a debounce timeout
async function executeScriptWithTimeout(scriptId, pathname, timeoutDuration = 10000) {
    let context;
    let scriptContent;

    // Check if the script is already loaded
    if (scriptTimeouts.has(scriptId)) {
        clearTimeout(scriptTimeouts.get(scriptId).timeout);
        context = scriptTimeouts.get(scriptId).context;
    } else {
        // Check if script exists on disk, else fetch from database
        const scriptPath = path.join(scriptsDirectory, `${scriptId}.js`);
        try {
            await fs.access(scriptPath);
            scriptContent = await fs.readFile(scriptPath, 'utf8');
        } catch {
            scriptContent = await fetchScriptFromDatabaseAndSave(scriptId, pathname);
        }

        // Execute the script
        context = new vm.createContext({});
        const script = new vm.Script(scriptContent);
        script.runInContext(context);
    }

    // Reset or set the timeout
    const timeout = setTimeout(() => {
        for (const key in context) {
            if (context.hasOwnProperty(key)) {
                delete context[key];
            }
        }
        scriptTimeouts.delete(scriptId);
        console.log(`Script ${scriptId} removed due to inactivity.`);
    }, timeoutDuration);

    // Update the map
    scriptTimeouts.set(scriptId, { context, timeout });
}

// Example usage
const scriptId = 'unique-script-id';
const pathname = '/path/to/script'; // Set the appropriate pathname

executeScriptWithTimeout(scriptId, pathname, 10000).then(() => {
    console.log(`Script ${scriptId} executed.`);
});


// Call this function at the start of your server
// generateExclusionList();

// Example usage
// const moduleName = 'your-module-name';
// clearModuleCache(moduleName);

module.exports = CoCreateLazyLoader;