/** Optional ESPN editorial metadata. Never used to infer event status or playable sources. */
const rows = value => Array.isArray(value) ? value.slice(0, 64) : [];
const text = (value, limit = 100) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
const record = team => {
  const row = rows(team?.records).find(r => String(r?.type).toLowerCase() === "total" || String(r?.name).toLowerCase() === "overall");
  return /^\d{1,3}(?:-\d{1,3}){1,3}$/.test(String(row?.summary || "").trim()) ? String(row.summary).trim() : "";
};
export function espnEventInfo(event, competition) {
  const competitors = rows(competition?.competitors);
  const home = competitors.find(r => r?.homeAway === "home");
  const away = competitors.find(r => r?.homeAway === "away");
  const round = ({ QF: "Quarterfinal", QTR: "Quarterfinal", SEMI: "Semifinal", SF: "Semifinal",
    FINAL: "Final", FIN: "Final", R16: "Round of 16", R32: "Round of 32" })[String(competition?.type?.abbreviation || "").toUpperCase()] || "";
  const week = event?.week?.number;
  const phase = ({ "pre-season": "Preseason", "regular-season": "Regular season", "post-season": "Postseason" })[event?.season?.slug] || "";
  const names = [
    ...rows(competition?.broadcasts).flatMap(r => rows(r?.names)),
    ...rows(competition?.geoBroadcasts).filter(r => String(r?.type?.shortName).toUpperCase() === "TV").map(r => r?.media?.shortName),
  ].map(n => text(n, 60)).filter(Boolean);
  const seen = new Set();
  return {
    stage: round || (Number.isInteger(week) && week > 0 && week <= 1000 ? `Week ${week}` : ""),
    note: text([...new Set(rows(competition?.notes).filter(r => r?.type === "event").map(r => text(r?.headline, 140)).filter(Boolean))].slice(0, 2).join(" · "), 140),
    phase,
    channels: names.filter(n => { const key = n.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 12),
    homeRecord: record(home), awayRecord: record(away),
  };
}
/** Preserve facts while orienting records to the retained row, never merely to the newest payload. */
export function mergeEventInfoRows(preferred, fallback, authority = preferred) {
  const targetHome = text(preferred?.homeTeam || fallback?.homeTeam);
  const targetAway = text(preferred?.awayTeam || fallback?.awayTeam);
  const result = { stage: "", note: "", phase: "", channels: [], homeRecord: "", awayRecord: "" };
  let found = false;
  for (const row of [authority, preferred, fallback]) {
    if (!row?.eventInfo || typeof row.eventInfo !== "object") continue;
    found = true;
    const info = row.eventInfo;
    result.stage ||= text(info.stage); result.note ||= text(info.note, 140); result.phase ||= text(info.phase, 40);
    if (!result.channels.length) result.channels = [...new Map(rows(info.channels).map(n => text(n, 60)).filter(Boolean).map(n => [n.toLowerCase(), n])).values()].slice(0, 12);
    const same = (a, b) => Boolean(a && b && text(a).toLowerCase() === text(b).toLowerCase());
    const straight = same(row.homeTeam, targetHome) && same(row.awayTeam, targetAway);
    const reverse = same(row.homeTeam, targetAway) && same(row.awayTeam, targetHome);
    const valid = value => typeof value === "string" && /^\d{1,3}(?:-\d{1,3}){1,3}$/.test(value) ? value : "";
    result.homeRecord ||= straight ? valid(info.homeRecord) : reverse ? valid(info.awayRecord) : "";
    result.awayRecord ||= straight ? valid(info.awayRecord) : reverse ? valid(info.homeRecord) : "";
  }
  return found ? result : undefined;
}