const Handlebars = require("handlebars");
const fs = require("fs");
const fsp = fs.promises;

class Formatter {
    async getTemplateContent(type)
    {
        return (await fsp.readFile(__dirname +'/templates/' + type + '.hbs')).toString();
    }

    async formatText(context) {
        const template = Handlebars.compile(await this.getTemplateContent('text'));
        return template(context);
    }

    async formatHtml(context) {
        const template = Handlebars.compile(await this.getTemplateContent('html'));
        return template(context);
    }

    async format(results) {
        const params = {servers: results};
        return {
            text: await this.formatText(params),
            html: await this.formatHtml(params)
        };
    }
}

module.exports = Formatter;
