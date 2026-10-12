function escapeCell(v) {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Build a CSV string from headers + rows. */
export function toCsv(headers, rows) {
    const lines = [headers, ...rows].map((r) => r.map(escapeCell).join(","));
    return lines.join("\r\n");
}
/** CSV as a Buffer for Discord file attachment. */
export function csvBuffer(headers, rows) {
    return Buffer.from("﻿" + toCsv(headers, rows), "utf-8"); // BOM for Excel
}
//# sourceMappingURL=csv.js.map