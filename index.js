#!/usr/bin/env node --no-warnings

const config = require("./config");
const Server = require("./server");
const formatter = require("./formatter");

async function processServers(servers) {
    const results = {errors: false, servers: {}};
    for (let name in servers) {
        const server = new Server(name, config, servers[name]);
        await server.connect();
        const result = await server.backup();
        results.servers[name] = result;
        if (result.errors) {
            results.errors = true;
        }
        
        server.close();
    }
    
    const formattedResults = await (new formatter()).format(results);
    
    for (let configuration of config.notifications) {
        const notificationClass = require("./notifications/" + configuration.type);
        const notifier = new notificationClass(configuration);
        await notifier.notify(results, formattedResults);
    }
}

processServers(config.servers).then(() => process.exit(0), e => console.error(e) && process.exit(1));
