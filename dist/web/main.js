/** Standalone entry for the dashboard (`npm run web`). The bot process starts
 * the same app itself via startDashboard() on ready. */
import { startDashboard } from "./server.js";
import { connectDb } from "../core/db.js";
await connectDb();
await startDashboard();
//# sourceMappingURL=main.js.map