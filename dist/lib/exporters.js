import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
export async function excelBuffer(sheetName, headers, rows) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Intern Org Bot";
    const ws = wb.addWorksheet(sheetName.slice(0, 31));
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    for (const r of rows)
        ws.addRow(r.map((c) => (c === null || c === undefined ? "" : c)));
    ws.columns.forEach((col) => {
        let max = 10;
        col.eachCell?.({ includeEmpty: false }, (cell) => {
            max = Math.max(max, String(cell.value ?? "").length + 2);
        });
        col.width = Math.min(max, 40);
    });
    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
}
export function pdfBuffer(title, headers, rows) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
        doc.fontSize(16).text(title, { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor("#000");
        const pageWidth = doc.page.width - 72;
        const colWidth = pageWidth / headers.length;
        const rowHeight = 16;
        const drawRow = (cells, bold) => {
            const y = doc.y;
            doc.font(bold ? "Helvetica-Bold" : "Helvetica");
            cells.forEach((c, i) => {
                doc.text(String(c ?? ""), 36 + i * colWidth, y, {
                    width: colWidth - 4,
                    height: rowHeight,
                    ellipsis: true,
                });
            });
            doc.y = y + rowHeight;
            if (doc.y > doc.page.height - 50)
                doc.addPage();
        };
        drawRow(headers, true);
        for (const r of rows)
            drawRow(r, false);
        doc.end();
    });
}
//# sourceMappingURL=exporters.js.map