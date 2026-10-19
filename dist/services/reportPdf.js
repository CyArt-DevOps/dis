import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
import { tzDateKey } from "../lib/time.js";
import { buildCalendars, memberProfile, eachDay } from "./calendar.js";
import { analyse } from "../lib/reportAnalysis.js";
import { tzDayStartUtc } from "../lib/time.js";
import { memberInsights } from "./insights.js";
import { memberWarnings, settledThrough } from "./warnings.js";
import { listHolidays } from "./holidays.js";
/**
 * Official member report on the CyArt letterhead: written evaluation plus
 * infographics (calendar, status mix, daily hours, login times), the dated
 * violation record, warnings, leave and meetings, signed off by the HR member
 * who generated it.
 */
const LETTERHEAD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "letterhead-header.png");
const C = {
    ink: "#111827",
    text: "#374151",
    muted: "#6b7280",
    faint: "#9ca3af",
    line: "#e5e7eb",
    panel: "#f9fafb",
    orange: "#f26b2c",
    green: "#3f9a3a",
    good: "#22c55e",
    partial: "#f59e0b",
    absent: "#ef4444",
    leave: "#fb923c",
    holiday: "#38bdf8",
    off: "#e5e7eb",
    untracked: "#f3f4f6",
};
const STATUS_COLOR = {
    good: C.good,
    partial: C.partial,
    missing: C.absent,
    leave: C.leave,
    holiday: C.holiday,
    off: C.off,
    untracked: C.untracked,
    future: "#ffffff",
};
const STATUS_LABEL = {
    good: "Completed",
    partial: "Partial",
    missing: "Absent",
    leave: "Leave",
    holiday: "Holiday",
    off: "Off day",
    untracked: "Not tracked",
    future: "Upcoming",
};
const VIOLATION_LABEL = {
    absent: "Absent",
    "late-login": "Late login",
    "short-hours": "Short hours",
    "meeting-absent": "Missed meeting",
    "meeting-late": "Late to meeting",
    warning: "Formal warning",
};
function hm(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
function fmtDay(day, opts = { day: "2-digit", month: "short", year: "numeric" }) {
    return new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
}
function fmtDate(d) {
    if (!d)
        return "-";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}
function pct(n) {
    return `${Math.round(n * 10) / 10}%`;
}
function rating(rate, workdays) {
    if (workdays === 0)
        return { label: "Not enough data", color: C.muted };
    if (rate >= 90)
        return { label: "Excellent", color: C.good };
    if (rate >= 75)
        return { label: "Good", color: C.green };
    if (rate >= 50)
        return { label: "Needs improvement", color: C.partial };
    return { label: "Unsatisfactory", color: C.absent };
}
export async function buildMemberReport(guildId, userId, period, preparedBy) {
    const today = tzDateKey(new Date());
    const to = period.to > today ? today : period.to;
    const profile = await memberProfile(guildId, userId, period.from, to);
    if (!profile.member || !profile.calendar)
        throw new Error("Member not found.");
    const [ins, warns, holidays] = await Promise.all([
        memberInsights(guildId, userId, profile.calendar, period.from, to),
        memberWarnings(guildId, userId),
        listHolidays(guildId),
    ]);
    const m = profile.member;
    const cal = profile.calendar;
    const p = org.attendancePolicy;
    const required = Math.round(p.minHours * 3600);
    const days = cal.days;
    // Only days whose verdict is final: today counts once its window has closed.
    const settledDay = settledThrough();
    const settled = days.filter((d) => d.status !== "future" && d.day <= settledDay);
    const count = (s) => settled.filter((d) => d.status === s).length;
    const t = {
        good: count("good"),
        partial: count("partial"),
        missing: count("missing"),
        leave: count("leave"),
        holiday: count("holiday"),
        off: count("off"),
    };
    const workdays = t.good + t.partial + t.missing;
    const rate = workdays ? (t.good / workdays) * 100 : 0;
    const presentDays = settled.filter((d) => d.firstJoinAt).length;
    const voice = settled.reduce((a, d) => a + d.seconds, 0);
    const lateDays = settled.filter((d) => (d.status === "partial" || d.status === "good") && d.firstJoinAt && !d.onTime).length;
    const shortDays = settled.filter((d) => d.status === "partial" && d.seconds < required).length;
    const periodHolidays = holidays.filter((h) => h.day >= period.from && h.day <= to);
    const periodLeaves = profile.leaves.filter((l) => tzDateKey(l.startAt) <= to && tzDateKey(l.endAt) >= period.from);
    const periodMeetings = profile.meetings.filter((mt) => {
        const d = tzDateKey(mt.scheduledStart);
        return d >= period.from && d <= to;
    });
    const mStats = { present: 0, late: 0, absent: 0, excused: 0 };
    for (const mt of periodMeetings)
        if (mt.status in mStats)
            mStats[mt.status]++;
    const mExpected = mStats.present + mStats.late + mStats.absent;
    const mPct = mExpected ? ((mStats.present + mStats.late) / mExpected) * 100 : 0;
    const r = rating(rate, workdays);
    // Peer comparison: everyone in the same project over the same period.
    let peers = null;
    if (m.project) {
        const cals = await buildCalendars(guildId, { project: m.project }, period.from, to);
        const scored = cals
            .map((c) => {
            const ds = c.days.filter((d) => d.day <= settledDay);
            const g = ds.filter((d) => d.status === "good").length;
            const w = ds.filter((d) => d.status === "good" || d.status === "partial" || d.status === "missing").length;
            const present = ds.filter((d) => d.seconds > 0);
            return { id: c.userId, rate: w ? (g / w) * 100 : 0, w, secs: present.reduce((a, d) => a + d.seconds, 0), present: present.length };
        })
            .filter((x) => x.w > 0);
        if (scored.length > 1) {
            const sorted = [...scored].sort((a, b) => a.rate - b.rate);
            const idx = sorted.findIndex((x) => x.id === userId);
            const totalPresent = scored.reduce((a, x) => a + x.present, 0);
            peers = {
                memberRate: rate,
                projectRate: scored.reduce((a, x) => a + x.rate, 0) / scored.length,
                projectAvgSeconds: totalPresent ? scored.reduce((a, x) => a + x.secs, 0) / totalPresent : 0,
                percentile: idx < 0 ? 50 : Math.round(((idx + 1) / sorted.length) * 100),
                project: m.project,
                size: scored.length,
            };
        }
    }
    const loginByMin = Number(p.loginBy.split(":")[0]) * 60 + Number(p.loginBy.split(":")[1]);
    const analysis = analyse({
        days: settled.map((d) => ({
            day: d.day,
            status: d.status,
            seconds: d.seconds,
            firstJoinMin: d.firstJoinAt ? Math.round((d.firstJoinAt.getTime() - tzDayStartUtc(d.day).getTime()) / 60_000) : null,
            onTime: d.onTime,
        })),
        requiredSeconds: required,
        loginByMin,
        name: m.fullName.split(" ")[0],
        peers,
    });
    const reportId = `CY-${userId.slice(-6)}-${today.replace(/-/g, "")}`;
    // ------------------------------------------------------------ document
    const doc = new PDFDocument({
        size: "A4",
        margins: { top: 100, bottom: 60, left: 48, right: 48 },
        bufferPages: true,
        info: {
            Title: `Attendance report - ${m.fullName}`,
            Author: `CyArt HR (${preparedBy})`,
            Subject: `Intern attendance and compliance report, ${period.label}`,
        },
    });
    // No em/en dashes anywhere in the report, including HR-typed text (warning
    // reasons, notes, leave reasons): "a — b" becomes "a, b" and "–" becomes "-".
    const clean = (v) => (typeof v === "string" ? v.replace(/\s*—\s*/g, ", ").replace(/–/g, "-") : v);
    const rawText = doc.text.bind(doc);
    const rawHeight = doc.heightOfString.bind(doc);
    doc.text = (t, ...rest) => rawText(clean(t), ...rest);
    doc.heightOfString = (t, ...rest) => rawHeight(clean(t), ...rest);
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    const done = new Promise((res) => doc.on("end", () => res(Buffer.concat(chunks))));
    const W = doc.page.width;
    const L = doc.page.margins.left;
    const R = W - doc.page.margins.right;
    const CW = R - L;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const hasLetterhead = existsSync(LETTERHEAD);
    const drawLetterhead = () => {
        if (hasLetterhead)
            doc.image(LETTERHEAD, 0, 0, { width: W });
        doc.y = doc.page.margins.top;
    };
    drawLetterhead();
    doc.on("pageAdded", drawLetterhead);
    const ensure = (h) => {
        if (doc.y + h > bottom())
            doc.addPage();
    };
    /** `keep` = height of the content that must stay on the same page as the heading. */
    const sectionTitle = (title, sub, keep = 0) => {
        ensure(48 + keep);
        doc.moveDown(0.6);
        const y = doc.y;
        // Heading: title with a short two-tone underline (brand orange + green).
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(12.5).text(title, L, y, { width: CW });
        const uy = doc.y + 2;
        doc.rect(L, uy, 18, 2).fill(C.orange);
        doc.rect(L + 20, uy, 8, 2).fill(C.green);
        doc.y = uy + 5;
        if (sub)
            doc.fillColor(C.muted).font("Helvetica").fontSize(8.5).text(sub, L, doc.y, { width: CW });
        doc.moveDown(0.5);
        doc.x = L;
    };
    const para = (text, opts = {}) => {
        doc.font("Helvetica").fontSize(opts.size ?? 9.5).fillColor(opts.color ?? C.text);
        const h = doc.heightOfString(text, { width: CW, lineGap: 2 });
        ensure(h + 4);
        doc.text(text, L, doc.y, { width: CW, lineGap: 2 });
        doc.moveDown(0.4);
    };
    const bullet = (text, color = C.orange) => {
        doc.font("Helvetica").fontSize(9.5);
        const h = doc.heightOfString(text, { width: CW - 14, lineGap: 2 });
        ensure(h + 3);
        const y = doc.y;
        doc.circle(L + 3, y + 5, 1.8).fill(color);
        doc.fillColor(C.text).text(text, L + 12, y, { width: CW - 14, lineGap: 2 });
        doc.moveDown(0.25);
    };
    /** Simple table with a header row, zebra rows and page breaks. */
    const table = (cols, rows, colors) => {
        const totalW = cols.reduce((a, c) => a + c.w, 0);
        const scale = CW / totalW;
        const ws = cols.map((c) => c.w * scale);
        const header = () => {
            ensure(22);
            const y = doc.y;
            doc.rect(L, y, CW, 18).fill("#111827");
            let x = L;
            cols.forEach((c, i) => {
                doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8).text(c.label.toUpperCase(), x + 6, y + 5.5, { width: ws[i] - 12, align: c.align ?? "left", lineBreak: false });
                x += ws[i];
            });
            doc.y = y + 18;
        };
        header();
        rows.forEach((row, ri) => {
            doc.font("Helvetica").fontSize(8.5);
            const h = Math.max(...row.map((cell, i) => doc.heightOfString(cell, { width: ws[i] - 12 }))) + 9;
            if (doc.y + h > bottom()) {
                doc.addPage();
                header();
            }
            const y = doc.y;
            if (ri % 2 === 1)
                doc.rect(L, y, CW, h).fill(C.panel);
            let x = L;
            row.forEach((cell, i) => {
                const color = i === 1 && colors?.[ri] ? colors[ri] : i === 0 ? C.ink : C.text;
                doc.fillColor(color).font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).text(cell, x + 6, y + 4.5, { width: ws[i] - 12, align: cols[i].align ?? "left" });
                x += ws[i];
            });
            doc.moveTo(L, y + h).lineTo(R, y + h).lineWidth(0.4).strokeColor(C.line).stroke();
            doc.y = y + h;
        });
        doc.x = L;
        doc.moveDown(0.6);
    };
    // ------------------------------------------------------------ title block
    doc.fillColor(C.orange).font("Helvetica-Bold").fontSize(8.5).text("INTERN ATTENDANCE & COMPLIANCE REPORT", L, doc.y, { characterSpacing: 1.2 });
    doc.moveDown(0.25);
    doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(20).text(m.fullName, L, doc.y, { width: CW });
    doc.fillColor(C.muted).font("Helvetica").fontSize(9.5).text(`${period.label}  |  ${fmtDay(period.from)} to ${fmtDay(to)}  |  Report ${reportId}  |  Generated ${fmtDay(today)}`, L, doc.y + 2, { width: CW });
    doc.moveDown(0.8);
    // Member details grid
    const details = [
        ["Discord", m.tag ? `@${m.tag}` : "-"],
        ["User ID", m.userId],
        ["Batch", m.batch ?? "-"],
        ["Project", m.project ?? "-"],
        ["Module / Pod", `${m.module ?? "-"} / ${m.pod ?? "-"}`],
        ["Verification", m.verificationStatus],
        ["Joined server", fmtDate(m.joinedAt)],
        ["Registered", fmtDate(ins.details.registrationDate)],
        ["Tracked since", ins.details.trackedFrom ? fmtDay(ins.details.trackedFrom) : "-"],
    ];
    {
        const cols = 3;
        const cw = CW / cols;
        const rh = 30;
        const y0 = doc.y;
        doc.roundedRect(L, y0, CW, rh * Math.ceil(details.length / cols), 6).lineWidth(0.6).strokeColor(C.line).stroke();
        details.forEach(([k, v], i) => {
            const x = L + (i % cols) * cw;
            const y = y0 + Math.floor(i / cols) * rh;
            doc.fillColor(C.faint).font("Helvetica").fontSize(7.5).text(k.toUpperCase(), x + 10, y + 6, { width: cw - 20, characterSpacing: 0.4 });
            doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(9.5).text(v, x + 10, y + 16, { width: cw - 20, lineBreak: false, ellipsis: true });
        });
        doc.y = y0 + rh * Math.ceil(details.length / cols) + 12;
    }
    // KPI tiles
    const kpis = [
        { label: "Compliance", value: pct(rate), sub: `${t.good} of ${workdays} working days`, color: r.color },
        { label: "Voice served", value: hm(voice), sub: `${presentDays ? hm(voice / presentDays) : "0h 00m"} per present day`, color: C.ink },
        { label: "Absent days", value: String(t.missing), sub: `${t.partial} partial · ${t.leave} leave`, color: t.missing ? C.absent : C.ink },
        { label: "On-time logins", value: pct(ins.period.onTimeRate), sub: ins.period.avgFirstJoin ? `avg first join ${ins.period.avgFirstJoin}` : "no logins", color: C.ink },
        { label: "Meetings", value: mExpected ? pct(mPct) : "-", sub: `${mStats.absent} missed · ${mStats.late} late`, color: C.ink },
        { label: "Warnings", value: `${warns.strikes}/${warns.strikeLimit}`, sub: "active strikes", color: warns.strikes ? C.absent : C.ink },
    ];
    {
        const n = 3;
        const gap = 8;
        const tw = (CW - gap * (n - 1)) / n;
        const th = 50;
        const ky = doc.y; // text calls move doc.y, so anchor the grid once
        kpis.forEach((k, i) => {
            const x = L + (i % n) * (tw + gap);
            const y = ky + Math.floor(i / n) * (th + gap);
            doc.roundedRect(x, y, tw, th, 6).fill(C.panel);
            doc.fillColor(C.muted).font("Helvetica").fontSize(7.5).text(k.label.toUpperCase(), x + 10, y + 8, { width: tw - 20, characterSpacing: 0.4 });
            doc.fillColor(k.color).font("Helvetica-Bold").fontSize(16).text(k.value, x + 10, y + 19, { width: tw - 20 });
            doc.fillColor(C.faint).font("Helvetica").fontSize(7.5).text(k.sub, x + 10, y + 38, { width: tw - 20, lineBreak: false, ellipsis: true });
        });
        doc.y = ky + 2 * th + gap + 6;
    }
    // ------------------------------------------------------------ evaluation (written)
    sectionTitle("Evaluation", `Policy: join voice by ${p.loginBy} and serve at least ${p.minHours} hours on every working day (Mon-Fri, excluding public holidays and approved leave).`);
    {
        const y = doc.y;
        doc.roundedRect(L, y, 150, 22, 11).fill(r.color);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9.5).text(`Overall: ${r.label}`, L, y + 7, { width: 150, align: "center" });
        doc.y = y + 30;
    }
    const first = m.fullName.split(" ")[0];
    const summary = workdays === 0
        ? `No working days fall within this period for ${m.fullName}, so no attendance evaluation can be made.`
        : `During ${period.label === "Full internship" ? "the full internship" : period.label} (${fmtDay(period.from)} to ${fmtDay(to)}), ${m.fullName} had ${workdays} working day${workdays === 1 ? "" : "s"} to attend. ` +
            `${first} fully met the attendance rules on ${t.good} of them (${pct(rate)}), attended but fell short on ${t.partial}, and was absent on ${t.missing}. ` +
            `${t.leave ? `${t.leave} day${t.leave === 1 ? " was" : "s were"} covered by approved leave` : "No approved leave was taken"}` +
            `${t.holiday ? ` and ${t.holiday} public holiday${t.holiday === 1 ? "" : "s"} were excluded` : ""}. ` +
            `In total ${first} served ${hm(voice)} in voice across ${presentDays} day${presentDays === 1 ? "" : "s"} of presence` +
            `${presentDays ? `, an average of ${hm(voice / presentDays)} per day present against the ${hm(required)} target` : ""}.`;
    para(summary);
    const obs = [];
    if (t.missing)
        obs.push({ text: `${t.missing} absence${t.missing === 1 ? "" : "s"} with no voice presence on a working day.`, color: C.absent });
    if (lateDays)
        obs.push({ text: `${lateDays} late login${lateDays === 1 ? "" : "s"} after the ${p.loginBy} cutoff${ins.period.avgFirstJoin ? `; average first join was ${ins.period.avgFirstJoin}` : ""}.`, color: C.partial });
    if (shortDays)
        obs.push({ text: `${shortDays} day${shortDays === 1 ? "" : "s"} under the ${p.minHours}-hour requirement while present.`, color: C.partial });
    if (mStats.absent || mStats.late)
        obs.push({ text: `Meetings: ${mStats.present} on time, ${mStats.late} late, ${mStats.absent} missed${mStats.excused ? `, ${mStats.excused} excused` : ""}.`, color: mStats.absent ? C.absent : C.partial });
    if (ins.lifetime.absentStreak >= 2)
        obs.push({ text: `Currently absent for ${ins.lifetime.absentStreak} consecutive working days.`, color: C.absent });
    if (ins.lifetime.currentStreak >= 3)
        obs.push({ text: `Positive: ${ins.lifetime.currentStreak} consecutive completed working days (best run ${ins.lifetime.bestStreak}).`, color: C.good });
    if (warns.strikes)
        obs.push({ text: `${warns.strikes} active formal warning${warns.strikes === 1 ? "" : "s"} on record (limit ${warns.strikeLimit}).`, color: C.absent });
    if (ins.projectRank)
        obs.push({ text: `Ranked ${ins.projectRank.rank} of ${ins.projectRank.of} in ${m.project} for this period.`, color: C.green });
    if (!obs.length)
        obs.push({ text: "No rule violations were recorded in this period.", color: C.good });
    doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("Key observations", L, doc.y);
    doc.moveDown(0.3);
    for (const o of obs)
        bullet(o.text, o.color);
    const recs = [];
    if (workdays === 0)
        recs.push("Re-run this report for a period that includes working days.");
    else if (rate >= 90)
        recs.push("Attendance is exemplary; continue the current routine.");
    else {
        if (t.missing)
            recs.push("Attend every working day or apply for leave in advance through the HR leave process; unexplained absences lead to formal warnings.");
        if (lateDays)
            recs.push(`Join voice by ${p.loginBy}; late first logins are recorded against compliance even when hours are completed.`);
        if (shortDays)
            recs.push(`Stay connected for the full ${p.minHours} hours within the ${p.windowStart}-${p.windowEnd} window.`);
        if (mStats.absent)
            recs.push("Attend scheduled meetings or inform the organiser and HR beforehand.");
    }
    if (recs.length) {
        doc.moveDown(0.3);
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("Recommendations", L, doc.y);
        doc.moveDown(0.3);
        for (const rc of recs)
            bullet(rc, C.green);
    }
    // ------------------------------------------------------------ detailed analysis (written)
    doc.addPage();
    sectionTitle("Detailed analysis", "Findings computed from this member's daily attendance records for the period.");
    for (const para2 of analysis.paragraphs) {
        ensure(40);
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text(para2.title, L, doc.y);
        doc.moveDown(0.2);
        para(para2.body);
    }
    if (analysis.weeks.length) {
        sectionTitle("Week by week", "Working days, verdicts and voice time for each week of the period.", 60);
        table([
            { label: "Week of", w: 90 },
            { label: "Compliance", w: 70, align: "right" },
            { label: "Days", w: 50, align: "right" },
            { label: "Completed", w: 65, align: "right" },
            { label: "Partial", w: 55, align: "right" },
            { label: "Absent", w: 55, align: "right" },
            { label: "Leave", w: 45, align: "right" },
            { label: "Voice", w: 70, align: "right" },
        ], analysis.weeks.map((w) => [
            fmtDay(w.weekOf, { day: "2-digit", month: "short" }),
            w.workdays ? pct(w.rate) : "-",
            String(w.workdays),
            String(w.good),
            String(w.partial),
            String(w.absent),
            String(w.leave),
            hm(w.seconds),
        ]), analysis.weeks.map((w) => (!w.workdays ? C.muted : w.rate >= 75 ? C.green : w.rate >= 50 ? C.partial : C.absent)));
    }
    if (analysis.weekdays.some((w) => w.workdays)) {
        sectionTitle("Weekday pattern", "Absences, short days and late logins by day of the week.", 120);
        const ch = 80;
        const y0 = doc.y + 4;
        const colW = CW / 5;
        const maxV = Math.max(1, ...analysis.weekdays.map((w) => w.absent + w.short + w.late));
        analysis.weekdays.forEach((w, i) => {
            const x = L + i * colW + colW * 0.3;
            const bw = colW * 0.4;
            let yTop = y0 + ch;
            for (const [v, color] of [
                [w.absent, C.absent],
                [w.short, C.partial],
                [w.late, "#eab308"],
            ]) {
                if (!v)
                    continue;
                const h = (v / maxV) * ch;
                yTop -= h;
                doc.rect(x, yTop, bw, h).fill(color);
            }
            if (!w.absent && !w.short && !w.late)
                doc.rect(x, y0 + ch - 2, bw, 2).fill(C.good);
            doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(8).text(w.weekday.slice(0, 3), L + i * colW, y0 + ch + 4, { width: colW, align: "center" });
            doc.fillColor(C.muted).font("Helvetica").fontSize(7).text(w.workdays ? `${w.absent}A · ${w.short}S · ${w.late}L of ${w.workdays}` : "no working days", L + i * colW, y0 + ch + 15, { width: colW, align: "center" });
        });
        doc.y = y0 + ch + 30;
        let lx = L;
        for (const [lbl, color] of [
            ["Absent (A)", C.absent],
            ["Short hours (S)", C.partial],
            ["Late login (L)", "#eab308"],
        ]) {
            doc.roundedRect(lx, doc.y + 1, 8, 8, 2).fill(color);
            doc.fillColor(C.text).font("Helvetica").fontSize(8).text(lbl, lx + 11, doc.y, { lineBreak: false });
            lx += 11 + doc.widthOfString(lbl) + 16;
        }
        doc.y += 16;
        doc.x = L;
    }
    // ------------------------------------------------------------ infographics
    doc.addPage();
    sectionTitle("Attendance calendar", "Each working day coloured by its verdict. Hours served shown inside the day.");
    const months = [...new Set(days.map((d) => d.day.slice(0, 7)))];
    const byDay = new Map(days.map((d) => [d.day, d]));
    const holidayName = new Map(periodHolidays.map((h) => [h.day, h.name]));
    for (const month of months) {
        const mdays = eachDay(`${month}-01`, `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`);
        const lead = (new Date(mdays[0] + "T00:00:00Z").getUTCDay() + 6) % 7;
        const rows = Math.ceil((lead + mdays.length) / 7);
        const cell = Math.min(34, (CW - 6 * 4) / 7);
        const gridH = 16 + 12 + rows * (cell * 0.72 + 4);
        ensure(gridH + 10);
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text(fmtDay(`${month}-01`, { month: "long", year: "numeric" }), L, doc.y);
        const y0 = doc.y + 4;
        const cw = (CW - 6 * 4) / 7;
        const ch = cell * 0.72;
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((w, i) => {
            doc.fillColor(C.muted).font("Helvetica").fontSize(7).text(w, L + i * (cw + 4), y0, { width: cw, align: "center" });
        });
        mdays.forEach((day, i) => {
            const pos = lead + i;
            const x = L + (pos % 7) * (cw + 4);
            const y = y0 + 12 + Math.floor(pos / 7) * (ch + 4);
            const d = byDay.get(day);
            const inProgress = day > settledDay && day <= today;
            const status = inProgress ? "future" : d && day >= period.from && day <= to ? d.status : "untracked";
            const fill = STATUS_COLOR[status] ?? C.untracked;
            doc.roundedRect(x, y, cw, ch, 4).fill(fill);
            if (status === "future")
                doc.roundedRect(x, y, cw, ch, 4).lineWidth(0.6).strokeColor(C.line).stroke();
            const dark = ["good", "missing", "holiday", "leave"].includes(status);
            doc.fillColor(dark ? "#ffffff" : C.muted).font("Helvetica-Bold").fontSize(8).text(String(Number(day.slice(-2))), x + 4, y + 3, { lineBreak: false });
            if (d && d.seconds > 0 && day >= period.from && day <= to) {
                doc.fillColor(dark ? "#ffffff" : C.text).font("Helvetica").fontSize(6.5).text(hm(d.seconds), x, y + ch - 10, { width: cw - 4, align: "right", lineBreak: false });
            }
            else if (inProgress) {
                doc.fillColor(C.muted).font("Helvetica").fontSize(6).text("in progress", x, y + ch - 10, { width: cw - 4, align: "right", lineBreak: false });
            }
            else if (status === "holiday") {
                doc.fillColor("#ffffff").font("Helvetica").fontSize(6).text((holidayName.get(day) ?? "Holiday").slice(0, 16), x + 2, y + ch - 10, { width: cw - 4, align: "right", lineBreak: false });
            }
        });
        doc.y = y0 + 12 + rows * (ch + 4) + 8;
        doc.x = L;
    }
    // Legend
    {
        ensure(16);
        let x = L;
        const y = doc.y;
        for (const s of ["good", "partial", "missing", "leave", "holiday", "off"]) {
            doc.roundedRect(x, y + 1, 8, 8, 2).fill(STATUS_COLOR[s]);
            doc.fillColor(C.text).font("Helvetica").fontSize(8).text(STATUS_LABEL[s], x + 11, y, { lineBreak: false });
            x += 11 + doc.widthOfString(STATUS_LABEL[s]) + 14;
        }
        doc.y = y + 18;
        doc.x = L;
    }
    // Status mix donut + breakdown
    sectionTitle("Day status breakdown", undefined, 130);
    {
        ensure(130);
        const segs = [
            { k: "good", v: t.good },
            { k: "partial", v: t.partial },
            { k: "missing", v: t.missing },
            { k: "leave", v: t.leave },
            { k: "holiday", v: t.holiday },
        ].filter((s) => s.v > 0);
        const total = segs.reduce((a, s) => a + s.v, 0);
        const cx = L + 60;
        const cy = doc.y + 58;
        const ro = 52;
        const ri = 32;
        if (total === 0) {
            doc.circle(cx, cy, ro).lineWidth(ro - ri).strokeColor(C.line).stroke();
        }
        else {
            let a0 = -Math.PI / 2;
            for (const s of segs) {
                const a1 = a0 + (s.v / total) * Math.PI * 2;
                const large = a1 - a0 > Math.PI ? 1 : 0;
                const pt = (rad, a) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`;
                if (s.v === total) {
                    doc.circle(cx, cy, (ro + ri) / 2).lineWidth(ro - ri).strokeColor(STATUS_COLOR[s.k]).stroke();
                }
                else {
                    doc.path(`M ${pt(ro, a0)} A ${ro} ${ro} 0 ${large} 1 ${pt(ro, a1)} L ${pt(ri, a1)} A ${ri} ${ri} 0 ${large} 0 ${pt(ri, a0)} Z`).fill(STATUS_COLOR[s.k]);
                }
                a0 = a1;
            }
        }
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(14).text(pct(rate), cx - 40, cy - 9, { width: 80, align: "center" });
        doc.fillColor(C.muted).font("Helvetica").fontSize(7).text("compliance", cx - 40, cy + 7, { width: 80, align: "center" });
        // breakdown bars
        const bx = L + 150;
        const bw = CW - 150;
        let by = cy - 52;
        const rowsB = [
            { k: "good", v: t.good },
            { k: "partial", v: t.partial },
            { k: "missing", v: t.missing },
            { k: "leave", v: t.leave },
            { k: "holiday", v: t.holiday },
        ];
        const maxV = Math.max(1, ...rowsB.map((x) => x.v));
        for (const row of rowsB) {
            doc.fillColor(C.text).font("Helvetica").fontSize(8.5).text(STATUS_LABEL[row.k], bx, by + 2, { width: 70 });
            doc.roundedRect(bx + 72, by + 3, bw - 110, 9, 4).fill(C.panel);
            if (row.v)
                doc.roundedRect(bx + 72, by + 3, Math.max(4, ((bw - 110) * row.v) / maxV), 9, 4).fill(STATUS_COLOR[row.k]);
            doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(8.5).text(String(row.v), bx + bw - 32, by + 2, { width: 30, align: "right" });
            by += 20;
        }
        doc.y = cy + ro + 14;
        doc.x = L;
    }
    // Daily hours chart
    sectionTitle("Daily hours served", `Bars show hours in voice per day; the dashed line is the ${p.minHours}-hour target.`, 150);
    const chartDays = days.filter((d) => d.day >= period.from && d.day <= to);
    {
        const ch = 120;
        ensure(ch + 30);
        const x0 = L + 24;
        const y0 = doc.y + 6;
        const w = CW - 24;
        const maxH = Math.max(p.minHours * 1.4, ...chartDays.map((d) => d.seconds / 3600));
        for (let hgrid = 0; hgrid <= maxH; hgrid += maxH > 10 ? 4 : 2) {
            const y = y0 + ch - (hgrid / maxH) * ch;
            doc.moveTo(x0, y).lineTo(x0 + w, y).lineWidth(0.3).strokeColor(C.line).stroke();
            doc.fillColor(C.faint).font("Helvetica").fontSize(6.5).text(`${hgrid}h`, L, y - 3, { width: 20, align: "right" });
        }
        const n = Math.max(1, chartDays.length);
        const slot = w / n;
        const bw = Math.max(1.5, slot * 0.7);
        chartDays.forEach((d, i) => {
            const hgt = (d.seconds / 3600 / maxH) * ch;
            const x = x0 + i * slot + (slot - bw) / 2;
            if (d.seconds > 0)
                doc.rect(x, y0 + ch - hgt, bw, hgt).fill(STATUS_COLOR[d.status] ?? C.good);
            else if (d.status === "missing" && d.day <= settledDay)
                doc.rect(x, y0 + ch - 2, bw, 2).fill(C.absent);
        });
        const ty = y0 + ch - (p.minHours / maxH) * ch;
        doc.moveTo(x0, ty).lineTo(x0 + w, ty).dash(3, { space: 3 }).lineWidth(0.8).strokeColor(C.ink).stroke().undash();
        const every = Math.ceil(n / 12);
        chartDays.forEach((d, i) => {
            if (i % every === 0)
                doc.fillColor(C.muted).font("Helvetica").fontSize(6.5).text(fmtDay(d.day, { day: "2-digit", month: "short" }), x0 + i * slot - 10, y0 + ch + 3, { width: slot + 20, align: "center", lineBreak: false });
        });
        doc.y = y0 + ch + 18;
        doc.x = L;
    }
    // First join chart
    sectionTitle("First login time", `Dots show when the member first joined voice each day; the shaded zone is after the ${p.loginBy} cutoff.`, 120);
    {
        const ch = 90;
        ensure(ch + 30);
        const x0 = L + 30;
        const y0 = doc.y + 6;
        const w = CW - 30;
        const lo = 8 * 60;
        const hi = 20 * 60;
        const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
        const yOf = (min) => y0 + ((Math.min(hi, Math.max(lo, min)) - lo) / (hi - lo)) * ch;
        const cut = yOf(toMin(p.loginBy));
        doc.rect(x0, cut, w, y0 + ch - cut).fill("#fef2f2");
        for (const hh of [8, 11, 14, 17, 20]) {
            const y = yOf(hh * 60);
            doc.moveTo(x0, y).lineTo(x0 + w, y).lineWidth(0.3).strokeColor(C.line).stroke();
            doc.fillColor(C.faint).font("Helvetica").fontSize(6.5).text(`${String(hh).padStart(2, "0")}:00`, L, y - 3, { width: 26, align: "right" });
        }
        doc.moveTo(x0, cut).lineTo(x0 + w, cut).dash(3, { space: 3 }).lineWidth(0.8).strokeColor(C.absent).stroke().undash();
        const n = Math.max(1, ins.daily.length);
        const slot = w / n;
        ins.daily.forEach((d, i) => {
            if (!d.firstJoin || d.day < period.from || d.day > to)
                return;
            const min = toMin(d.firstJoin);
            doc.circle(x0 + i * slot + slot / 2, yOf(min), 2.6).fill(min > toMin(p.loginBy) ? C.absent : C.good);
        });
        doc.y = y0 + ch + 10;
        doc.x = L;
    }
    // ------------------------------------------------------------ violations (written)
    doc.addPage();
    const v = ins.violations.filter((x) => x.day >= period.from && x.day <= to);
    sectionTitle("Violation record", v.length ? `${v.length} rule violation${v.length === 1 ? "" : "s"} recorded in this period, newest first.` : "No rule violations were recorded in this period.");
    if (v.length) {
        const sevColor = (s) => (s === "high" ? C.absent : s === "medium" ? C.partial : C.muted);
        table([
            { label: "Date", w: 70 },
            { label: "Type", w: 80 },
            { label: "Details", w: 260 },
            { label: "Severity", w: 55 },
        ], v.map((x) => [fmtDay(x.day, { weekday: "short", day: "2-digit", month: "short" }), VIOLATION_LABEL[x.kind] ?? x.kind, x.detail, x.severity.toUpperCase()]), v.map((x) => sevColor(x.severity)));
    }
    // Warnings
    sectionTitle("Formal warnings", `${warns.strikes} active of ${warns.strikeLimit}. Reaching ${warns.strikeLimit} warnings results in termination for non-compliance.`);
    const issued = warns.warnings.filter((w) => w.status !== "proposed");
    if (issued.length) {
        table([
            { label: "No.", w: 40 },
            { label: "Status", w: 80 },
            { label: "Reason", w: 250 },
            { label: "Issued", w: 95 },
        ], issued.map((w) => [
            `#${w.id}`,
            w.status === "acknowledged" ? "Acknowledged" : w.status === "revoked" ? "Revoked" : w.status === "dismissed" ? "Dismissed" : w.status === "dm-failed" ? "DM failed" : "Awaiting ack",
            w.reason.split("\n")[0] + (w.notes.length ? `\nHR notes: ${w.notes.map((n) => n.body).join(" | ")}` : ""),
            `${fmtDate(w.sentAt ?? w.createdAt)}\nby ${w.issuedBy}`,
        ]), issued.map((w) => (w.status === "revoked" || w.status === "dismissed" ? C.muted : w.status === "acknowledged" ? C.green : C.absent)));
    }
    else
        para("No formal warnings have been issued.", { color: C.muted });
    // Leave
    sectionTitle("Leave & holidays");
    if (periodLeaves.length) {
        table([
            { label: "Type", w: 70 },
            { label: "Status", w: 70 },
            { label: "Dates", w: 150 },
            { label: "Reason", w: 175 },
        ], periodLeaves.map((l) => [
            `${l.type[0].toUpperCase()}${l.type.slice(1)}`,
            l.status,
            l.approvedDays ? l.approvedDays.split(",").map((d) => fmtDay(d, { day: "2-digit", month: "short" })).join(", ") : `${fmtDate(l.startAt)} to ${fmtDate(l.endAt)}`,
            l.reason,
        ]), periodLeaves.map((l) => (l.status === "approved" ? C.green : l.status === "pending" ? C.partial : C.absent)));
    }
    else
        para("No leave requests in this period.", { color: C.muted });
    if (periodHolidays.length) {
        para(`Public holidays excluded from attendance: ${periodHolidays.map((h) => `${h.name} (${fmtDay(h.day, { day: "2-digit", month: "short" })})`).join(", ")}.`);
    }
    // Meetings
    sectionTitle("Meetings", mExpected ? `Attendance ${pct(mPct)}: ${mStats.present} on time, ${mStats.late} late, ${mStats.absent} missed, ${mStats.excused} excused.` : "No meetings were scheduled for this member in the period.");
    if (periodMeetings.length) {
        table([
            { label: "Meeting", w: 230 },
            { label: "Status", w: 80 },
            { label: "Date", w: 110 },
            { label: "Late by", w: 50, align: "right" },
        ], periodMeetings.slice(0, 40).map((mt) => [
            mt.title,
            mt.status,
            mt.scheduledStart.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }),
            mt.minutesLate ? `${mt.minutesLate} min` : "-",
        ]), periodMeetings.slice(0, 40).map((mt) => (mt.status === "present" ? C.green : mt.status === "late" ? C.partial : mt.status === "absent" ? C.absent : C.muted)));
    }
    // Conclusion (kept on the same page as the sign-off block)
    sectionTitle("Conclusion and HR assessment", undefined, 200);
    {
        const y = doc.y;
        doc.font("Helvetica").fontSize(9.5);
        const h = doc.heightOfString(analysis.conclusion, { width: CW - 24, lineGap: 2 }) + 16;
        ensure(h);
        doc.roundedRect(L, doc.y, CW, h, 6).fill(C.panel);
        doc.rect(L, doc.y, 3, h).fill(r.color);
        doc.fillColor(C.ink).font("Helvetica").fontSize(9.5).text(analysis.conclusion, L + 14, doc.y + 8, { width: CW - 24, lineGap: 2 });
        doc.y = Math.max(doc.y, y) + 10;
        doc.x = L;
    }
    // Sign-off
    ensure(110);
    doc.moveDown(1.2);
    const sy = doc.y;
    doc.moveTo(L, sy).lineTo(R, sy).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text("Generated by", L, sy + 12);
    doc.fillColor(C.text).font("Helvetica").fontSize(10).text(`${preparedBy}, Human Resources, CyArt`, L, sy + 27);
    doc.fillColor(C.muted).fontSize(8.5).text(`Date: ${fmtDay(today)}  |  Report ID: ${reportId}`, L, sy + 41);
    doc.fillColor(C.faint).fontSize(7.5).text("This is a computer-generated report and does not require a signature. It is produced from CyArt's attendance system (voice presence, leave and meeting records) at the request of the HR member named above.", L, sy + 60, { width: CW });
    // Footer on every page: confidentiality + page numbers (drawn last so totals are known).
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // Footer sits inside the bottom margin; lift the margin so pdfkit doesn't page-break.
        doc.page.margins.bottom = 0;
        const fy = doc.page.height - 36;
        doc.moveTo(L, fy - 6).lineTo(R, fy - 6).lineWidth(0.4).strokeColor(C.line).stroke();
        doc.fillColor(C.faint).font("Helvetica").fontSize(7.5);
        doc.text(`${m.fullName} - ${period.label} - ${reportId}`, L, fy, { width: CW / 2, lineBreak: false });
        doc.text(`Page ${i - range.start + 1} of ${range.count}`, L + CW / 2, fy, { width: CW / 2, align: "right", lineBreak: false });
    }
    doc.end();
    const pdf = await done;
    const safe = m.fullName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return { pdf, filename: `CyArt_Report_${safe}_${period.from}_to_${to}.pdf` };
}
/** Period presets: a calendar month, or the whole internship so far. */
export function reportPeriod(kind, month, trackedFrom) {
    const today = tzDateKey(new Date());
    if (kind === "full") {
        const from = trackedFrom ?? org.attendancePolicy.trackingStartsOn ?? today.slice(0, 7) + "-01";
        return { from, to: today, label: "Full internship" };
    }
    const mm = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
    const [y, mo] = mm.split("-").map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return {
        from: `${mm}-01`,
        to: `${mm}-${String(last).padStart(2, "0")}`,
        label: new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    };
}
/** Tracked-from for the full-internship preset. */
export async function trackedFromOf(guildId, userId) {
    const first = await prisma.attendance.findFirst({ where: { guildId, userId }, orderBy: { day: "asc" }, select: { day: true } });
    const member = await prisma.member.findUnique({ where: { id: userId }, select: { joinedAt: true } });
    const joined = member ? tzDateKey(member.joinedAt) : null;
    const candidates = [first?.day, joined].filter((d) => Boolean(d)).sort();
    let from = candidates[0] ?? null;
    const ts = org.attendancePolicy.trackingStartsOn;
    if (from && ts && from < ts)
        from = ts;
    return from;
}
//# sourceMappingURL=reportPdf.js.map