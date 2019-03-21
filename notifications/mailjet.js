const mailjet = require("node-mailjet");

class MailjetNotifications {
    constructor(config) {
        this.config = config;
    }

    async notify(results, formattedResults) {
        const client = mailjet.connect(
            this.config.key,
            this.config.secret
        );

        return client.post("send", { version: "v3.1" }).request({
            Messages: [
                {
                    From: this.config.from,
                    To: [this.config.to],
                    Subject: "Backup results",
                    HTMLPart: formattedResults.html
                }
            ]
        });
    }
}

module.exports = MailjetNotifications;
