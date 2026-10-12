import { registry } from "../core/registry.js";
import { ping } from "./ping.js";
import { setup } from "./setup.js";
import { lead } from "./lead.js";
import { colead } from "./colead.js";
import { announce } from "./announce.js";
import { moderationCommands } from "./moderation.js";
import { project } from "./project.js";
import { ticket } from "./ticket.js";
import { meeting } from "./meeting.js";
import { attendance } from "./attendance.js";
import { dashboard } from "./dashboard.js";
import { panel } from "./panel.js";
import { assign } from "./assign.js";
import { leave } from "./leave.js";
import { schedule } from "./schedule.js";
export function registerAllCommands() {
    registry.registerCommand(ping);
    registry.registerCommand(setup);
    registry.registerCommand(lead);
    registry.registerCommand(colead);
    registry.registerCommand(announce);
    registry.registerCommand(project);
    registry.registerCommand(ticket);
    registry.registerCommand(meeting);
    registry.registerCommand(attendance);
    registry.registerCommand(dashboard);
    registry.registerCommand(panel);
    registry.registerCommand(assign);
    registry.registerCommand(leave);
    registry.registerCommand(schedule);
    for (const cmd of moderationCommands)
        registry.registerCommand(cmd);
}
//# sourceMappingURL=index.js.map