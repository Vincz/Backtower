
const notifier = require('node-notifier');

class NativeNotifications {
    constructor(config) {
        this.config = config;
    }

    async notify(results, formattedResults) {
        const {success, failed}  = this.config.messages;
        notifier.notify(results.errors ? failed : success);
    }
}

module.exports = NativeNotifications;
