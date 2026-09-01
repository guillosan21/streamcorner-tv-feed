import { writeFile } from "node:fs/promises";

const CHANNELS_URL = "https://iptv-org.github.io/api/channels.json";
const LOGOS_URL = "https://iptv-org.github.io/api/logos.json";
const CATALOG_URL = "https://dlstreams.st/24-7-channels.php";

const COUNTRY_TOKENS = new Map([
  ["usa", "US"], ["us", "US"], ["mx", "MX"], ["mexico", "MX"], ["ca", "CA"], ["canada", "CA"],
  ["uk", "UK"], ["serbia", "RS"], ["croatia", "HR"], ["france", "FR"], ["spain", "ES"],
  ["germany", "DE"], ["de", "DE"], ["italy", "IT"], ["poland", "PL"], ["pl", "PL"], ["portugal", "PT"],
  ["netherland", "NL"], ["nl", "NL"], ["sweden", "SE"], ["denmark", "DK"], ["norway", "NO"],
  ["sw", "SE"], ["australia", "AU"], ["au", "AU"], ["india", "IN"], ["in", "IN"], ["turkey", "TR"], ["argentina", "AR"],
  ["brazil", "BR"], ["brasil", "BR"], ["chile", "CL"], ["colombia", "CO"], ["columbia", "CO"],
  ["uruguay", "UY"], ["uae", "AE"], ["qatar", "QA"], ["israel", "IL"], ["pk", "PK"],
  ["arabic", "QA"], ["mena", "QA"], ["greece", "GR"], ["bulgaria", "BG"], ["cz", "CZ"],
  ["sk", "SK"], ["nz", "NZ"], ["malaysia", "MY"], ["russia", "RU"], ["ireland", "IE"],
]);

function normalized(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\bsports\b/g, "sport").trim();
}

function catalogIdentity(name) {
  const withoutParentheses = String(name || "").replace(/\([^)]*\)/g, " ");
  const words = normalized(withoutParentheses).split(" ").filter(Boolean);
  let country = "";
  const kept = words.filter((word) => {
    const match = COUNTRY_TOKENS.get(word);
    if (match) { country ||= match; return false; }
    return !["hd", "uhd", "4k", "english"].includes(word);
  });
  return { key: kept.join(" "), country };
}

function catalogChannels(html) {
  const result = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href=["'][^"']*watch\.php\?id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = match[2].replace(/<[^>]*>/g, " ").replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ")
      .replace(/Espa単ol/gi, "Español")
      .replace(/\s*ID:\s*\d+\s*$/i, "").replace(/\s+/g, " ").trim();
    result.push({ id: match[1], name });
  }
  return result;
}

const [catalogResponse, channelResponse, logoResponse] = await Promise.all([
  fetch(CATALOG_URL), fetch(CHANNELS_URL), fetch(LOGOS_URL),
]);
if (!catalogResponse.ok || !channelResponse.ok || !logoResponse.ok) throw new Error("Logo metadata download failed");
const catalog = catalogChannels(await catalogResponse.text());
const channels = await channelResponse.json();
const logos = await logoResponse.json();
const logosByChannel = Map.groupBy(logos.filter((logo) => logo.in_use && /^https:\/\//i.test(logo.url)), (logo) => logo.channel);
const identities = [];
for (const channel of channels) {
  for (const candidateName of [channel.name, ...(channel.alt_names || [])]) {
    const identity = catalogIdentity(candidateName);
    if (identity.key) identities.push({ ...identity, country: channel.country, channelId: channel.id });
  }
}

const mapping = {};
for (const item of catalog) {
  const wanted = catalogIdentity(item.name);
  const candidates = identities.filter((candidate) => candidate.key === wanted.key);
  const matched = candidates.find((candidate) => wanted.country && candidate.country === wanted.country) ||
    (candidates.length === 1 ? candidates[0] : candidates.find((candidate) => candidate.country === "US")) || candidates[0];
  if (!matched) continue;
  const logo = (logosByChannel.get(matched.channelId) || []).sort((left, right) =>
    ((right.width || 0) * (right.height || 0)) - ((left.width || 0) * (left.height || 0)),
  )[0];
  if (logo) mapping[item.id] = logo.url;
}

await writeFile(new URL("./dlstreams-logos.json", import.meta.url), `${JSON.stringify(mapping, null, 2)}\n`);
console.log(JSON.stringify({ catalogChannels: catalog.length, matchedLogos: Object.keys(mapping).length }, null, 2));
