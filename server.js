const _ = require("lodash");
const rra = require('recursive-readdir-async');
const rsync = require("rsyncwrapper");
const moment = require("moment");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const simpleGit = require('simple-git/promise');

class Server {
    constructor(name, defaultConfig = {}, config = {}) {
        this.name = name;
        this.defaultConfig = defaultConfig;
        this.config = config;
        this.connection = null;
        this.debug = config.debug || defaultConfig.debug;

        this.commands = config.commands || [];
        this.folders = config.folders || [];

        this.tokens = {
            "%server%": name,
            "%year%": moment().format("YYYY"),
            "%month%": moment().format("MM"),
            "%day%": moment().format("DD"),
            "%week%": moment().format("WW")
        };
    }

    applyTemplate(entry) {
        for (let token in this.tokens) {
            entry = entry.replace(token, this.tokens[token]);
        }

        return entry;
    }

    resolveCondition(type) {
        if (_.isFinite(type)) {
            return type(this);
        }

        switch (type) {
            case "daily":
                return true;
            case "weekly":
                return moment().format("E") == 1;
            case "monthly":
                return moment().format("D") == 1;
        }

        return false;
    }

    async getBackupFile(target, mkdir = true) {
        target = this.applyTemplate(target);
        if (path.isAbsolute(target)) {
            return target;
        }

        let dir = this.config.backupDir || this.name;
        if (dir && path.isAbsolute(dir)) {
            return path.join(dir, target);
        }

        let defaultDir = this.defaultConfig.backupDir;

        if (!defaultDir || !path.isAbsolute(defaultDir)) {
            throw new Error("Missing backup directory for server " + this.name);
        }
        dir = dir ? path.join(defaultDir, dir) : defaultDir;
        let outputFile = path.join(dir, target);

        if (mkdir) {
            await fsp.mkdir(path.dirname(outputFile), { recursive: true });
        }

        return outputFile;
    }

    async getBackupStream(target, mkdir = true) {
        return fs.createWriteStream(await this.getBackupFile(target, mkdir));
    }

    async keepLatestFiles(folder, nb = 100) {
        const files = [];
        for (let f of await fsp.readdir(folder)) {
            const filepath = path.join(folder, f);
            const fstat = await fsp.stat(filepath);

            if (fstat.isFile() && path.basename(filepath)[0] != ".") {
                files.push({ path: filepath, fstat: fstat });
            }
        }
        const ordered = _.orderBy(files, file => file.fstat.ctime, "desc");
        const deleted = ordered.slice(nb);
        for (let file of deleted) {
            await fsp.unlink(file.path);
        }

        return deleted.map(d => d.path);
    }

    getHost() {
        return this.config.host;
    }

    getSshPort() {
        return this.config.port || 22;
    }

    getSshUser() {
        return this.config.user || this.defaultConfig.user || "root";
    }

    getSshKeyPath() {
        return this.config.key || this.defaultConfig.key;
    }

    async connect() {
        if (this.config.local) {
            return;
        }

        return new Promise((resolve, reject) => {
            this.connection = new require("ssh2").Client();
            try {
                this.connection
                    .on("ready", function() {
                        resolve();
                    })
                    .connect({
                        host: this.getHost(),
                        port: this.getSshPort(),
                        username: this.getSshUser(),
                        privateKey: require("fs").readFileSync(this.getSshKeyPath())
                    });
            } catch (e) {
                return reject(e);
            }
        });
    }

    async execCommand(command, outStreams, env = {}) {
        return new Promise((resolve, reject) => {
            this.connection.exec(command, env, (err, stream) => {
                if (err) {
                    return reject(err);
                }
                for (let outStream of outStreams) {
                    stream.pipe(outStream);
                }
                let errors = "";
                stream
                    .on("close", function(code, signal) {
                        if (errors.length > 0) {
                            reject(errors);
                        } else {
                            resolve();
                        }
                    })
                    .stderr.on("data", function(data) {
                        errors = errors.concat(data);
                    });
            });
        });
    }

    normalizeOutputs(outputs) {
        const list = [];
        if (_.isString(outputs)) {
            list.push({ file: outputs });
        } else if (_.isArray(outputs)) {
            for (let output of outputs) {
                list.push(_.isString(output) ? { file: output } : output);
            }
        }

        return list;
    }

    async command(command) {
        const outStreams = [];
        const outputs = this.normalizeOutputs(command.outputs);

        for (let output of outputs) {
            if (output.condition && !this.resolveCondition(output.condition)) {
                continue;
            }

            if (output.file) {
                outStreams.push(await this.getBackupStream(output.file));
            }
        }
        const deletedFiles = [];

        try {
            await this.execCommand(command.exec, outStreams, command.env || {});
            for (let output of outputs) {
                if (output.keep && output.file) {
                    const folder = path.dirname(await this.getBackupFile(output.file));
                    deletedFiles.concat(await this.keepLatestFiles(folder, output.keep));
                }
            }
            return { status: true, command, deletedFiles };
        } catch (error) {
            return { status: false, command, error };
        }
    }

    async execSynchronize(options) {
        return new Promise((resolve, reject) => {
            rsync(options, (error, stdout, stderr, cmd) => {
                if (error) {
                    return reject(error);
                } else {
                    return resolve(stdout);
                }
            });
        });
    }

    async getIgnoredGitFiles(from) {
        const tree = await rra.list(from, {ignoreFolders: false, mode: rra.TREE});
        const git = simpleGit(from);
        const isIgnored = async path => (await git.checkIgnore([path])).length > 0;

        const getExcluded = async (file) => {
            let excluded = [];
            const ignored = await isIgnored(file.fullname);
            if (ignored) {
                excluded.push(file.fullname);
            }

            if (file.isDirectory && !ignored && file.content) {
                const ignoredContent = await git.checkIgnore(file.content.map(f => f.fullname));
                excluded = [...excluded, ...ignoredContent];
                const subDirectories = file.content.filter(file => {
                    return file.isDirectory && ignoredContent.indexOf(file.fullname) == -1;
                });

                for (let subDirectory of subDirectories) {
                    excluded = [...excluded, ...(await getExcluded(subDirectory))];
                }
            }
            
            return excluded;
        }

        let excluded = [];
        for(let f of tree) {
            excluded = [...excluded, ...(await getExcluded(f))];
        }

        return excluded.map(f => path.relative(from, f));
    }

    async synchronize(synchronize) {
        let src = synchronize.from;
        let dest = await this.getBackupFile(synchronize.to);
        
        if (!this.config.local) {
            src = `${this.getSshUser()}@${this.getHost()}:${src}`;
        }

        let exclude = synchronize.exclude || [];
        if (synchronize.gitignore) {
            exclude = [...exclude, ...(await this.getIgnoredGitFiles(src))];
        }

        let options = {
            src,
            dest,
            recursive: true,
            exclude
        };

        console.log("Excluding ", exclude);

        if (!this.config.local) {
            options = {
                ...options,
                ssh: true,
                port: this.getSshPort(),
                privateKey: this.getSshKeyPath(),
            }
        }

        try {
            await this.execSynchronize(options);
            return { status: true, synchronize };
        } catch (e) {
            return { status: false, synchronize, error: e };
        }
    }

    close() {
        if (this.connection) {
            this.connection.end();
        }
    }

    async backup() {
        const results = { commands: [], folders: [] };
        for (let command of this.commands) {
            results.commands.push(await this.command(command));
        }

        for (let folder of this.folders) {
            results.folders.push(await this.synchronize(folder));
        }
        console.log(results);
        return results;
    }
}

module.exports = Server;
