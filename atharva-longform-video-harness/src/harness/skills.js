const fs = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { PROJECT, noSymlinks, atomicWrite } = require("./workspace");

const REVISION = "3c9c949421e4aa86dba444dfe8cba46d000f9d87";
const CACHE = join(PROJECT, "build/skill-cache", REVISION);
const NAMES = ["engine", "animate", "review", "style-line", "style-risograph", "style-paper-cutout"];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function syncSkills() {
  noSymlinks(PROJECT, CACHE);
  fs.mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  const manifest = { repository: "https://github.com/illodev/drawn-by-code", revision: REVISION, files: {} };
  for (const name of [...NAMES, "LICENSE", "riso-kit"]) {
    const source = name === "LICENSE" ? "LICENSE" : name === "riso-kit" ? "styles/risograph/riso.js" : `.claude/skills/${name}/SKILL.md`;
    const url = `https://raw.githubusercontent.com/illodev/drawn-by-code/${REVISION}/${source}`;
    const result = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!result.ok) throw new Error("Pinned skill download failed.");
    const text = await result.text();
    if (text.length > 60000) throw new Error("Upstream skill exceeds size limit.");
    const file = name === "LICENSE" ? "LICENSE" : name === "riso-kit" ? "riso.js" : `${name}.md`;
    atomicWrite(noSymlinks(PROJECT, join(CACHE, file)), text);
    manifest.files[name] = { source, sha256: sha256(text) };
  }
  atomicWrite(noSymlinks(PROJECT, join(CACHE, "manifest.json")), JSON.stringify(manifest, null, 2));
  return { revision: REVISION, skills: NAMES };
}

function readSkill(name) {
  if (!NAMES.includes(name)) throw new Error("Unknown skill.");
  const manifest = JSON.parse(fs.readFileSync(noSymlinks(PROJECT, join(CACHE, "manifest.json")), "utf8"));
  const text = fs.readFileSync(noSymlinks(PROJECT, join(CACHE, `${name}.md`)), "utf8");
  if (manifest.revision !== REVISION || sha256(text) !== manifest.files[name]?.sha256) throw new Error("Skill cache integrity check failed.");
  return { name, revision: REVISION, text };
}

function readRisoKit() {
  const manifest = JSON.parse(fs.readFileSync(noSymlinks(PROJECT, join(CACHE, "manifest.json")), "utf8"));
  const source = fs.readFileSync(noSymlinks(PROJECT, join(CACHE, "riso.js")), "utf8");
  if (manifest.revision !== REVISION || sha256(source) !== manifest.files["riso-kit"]?.sha256) throw new Error("Risograph kit cache integrity check failed; run skills:sync.");
  return source;
}

module.exports = { syncSkills, readSkill, readRisoKit, NAMES, REVISION };
