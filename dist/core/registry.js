class Registry {
    commands = new Map();
    handlers = [];
    registerCommand(cmd) {
        this.commands.set(cmd.data.name, cmd);
    }
    registerHandler(handler) {
        this.handlers.push(handler);
    }
}
export const registry = new Registry();
//# sourceMappingURL=registry.js.map