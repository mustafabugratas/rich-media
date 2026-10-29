// Posts the due entries of schedule.json to Instagram (run by
// .github/workflows/publish.yml, or by hand with IG_TOKEN set):
//
//   node publish.mjs            post what is due
//   node publish.mjs --check    check the token
//   node publish.mjs --dry-run  list what would be posted
//
// An entry is due when it is approved, has media, its time has passed, it
// is less than 6 hours late and it is not in posted.json. Guards: the token
// must belong to IG_EXPECT, one post per run, and nothing is posted while the
// account's newest post is younger than IG_MIN_GAP_H hours. Each post is
// recorded in posted.json (with its link), which the workflow commits.
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://graph.instagram.com/v23.0";
const LATE_MS = 6 * 60 * 60 * 1000;
const token = process.env.IG_TOKEN;
if (!token) {
  console.error("publish: IG_TOKEN is not set");
  process.exit(1);
}

async function call(method, path, params = {}) {
  const url = `${API}${path}`;
  const body = new URLSearchParams({ ...params, access_token: token });
  let res;
  try {
    res = method === "GET" ? await fetch(`${url}?${body}`) : await fetch(url, { method, body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  } catch {
    // A network error can carry the request URL, which holds the token.
    throw new Error(`${method} ${path}: network error`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    throw new Error(`${method} ${path}: ${res.status} ${e.type ?? ""} ${e.message ?? JSON.stringify(json)}`.trim());
  }
  return json;
}

async function waitFinished(id) {
  for (let i = 0; i < 60; i++) {
    const { status_code: status } = await call("GET", `/${id}`, { fields: "status_code" });
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") throw new Error(`container ${id} ended ${status}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`container ${id} not finished after 10 minutes`);
}

async function post(userId, p) {
  let creation;
  if (p.kind === "reel") {
    ({ id: creation } = await call("POST", `/${userId}/media`, { media_type: "REELS", video_url: p.media[0], caption: p.caption, share_to_feed: "true", ...(p.cover && { cover_url: p.cover }) }));
  } else if (p.media.length === 1) {
    ({ id: creation } = await call("POST", `/${userId}/media`, { image_url: p.media[0], caption: p.caption }));
  } else {
    const children = [];
    for (const image_url of p.media) {
      const { id } = await call("POST", `/${userId}/media`, { image_url, is_carousel_item: "true" });
      await waitFinished(id);
      children.push(id);
    }
    ({ id: creation } = await call("POST", `/${userId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: p.caption }));
  }
  await waitFinished(creation);
  const { id } = await call("POST", `/${userId}/media_publish`, { creation_id: creation });
  return id;
}

const me = await call("GET", "/me", { fields: "user_id,username" });
console.log(`publish: token ok for @${me.username}`);
if (process.env.IG_EXPECT && me.username !== process.env.IG_EXPECT) {
  console.error(`publish: the token is for @${me.username}, not @${process.env.IG_EXPECT}; nothing posted`);
  process.exit(1);
}
if (process.argv.includes("--check")) process.exit(0);

const dry = process.argv.includes("--dry-run");
const { posts } = JSON.parse(readFileSync(new URL("./schedule.json", import.meta.url), "utf8"));
const postedFile = new URL("./posted.json", import.meta.url);
const posted = JSON.parse(readFileSync(postedFile, "utf8"));
const key = (p) => `${p.date}-${p.kind}`;
const now = Date.now();

if (process.env.IG_MIN_GAP_H && !dry) {
  const { data } = await call("GET", `/${me.user_id}/media`, { fields: "timestamp", limit: "1" });
  const last = data?.[0] ? Date.parse(data[0].timestamp) : 0;
  if (now - last < Number(process.env.IG_MIN_GAP_H) * 3600_000) {
    console.log(`publish: newest post is from ${data[0].timestamp}, less than ${process.env.IG_MIN_GAP_H} h ago; nothing posted this run`);
    process.exit(0);
  }
}

let failed = false;
for (const p of posts) {
  if (!p.approved || !p.media?.length || posted.posts[key(p)]) continue;
  const at = Date.parse(`${p.date}T${p.time}`);
  if (at > now) continue;
  if (now - at > LATE_MS) {
    console.log(`skip ${key(p)}: more than 6 hours late, reschedule it`);
    continue;
  }
  if (dry) {
    console.log(`would post ${key(p)} ${p.id} (${p.media.length} file${p.media.length > 1 ? "s" : ""})`);
    continue;
  }
  try {
    const mediaId = await post(me.user_id, p);
    const { permalink } = await call("GET", `/${mediaId}`, { fields: "permalink" }).catch(() => ({}));
    posted.posts[key(p)] = { id: p.id, mediaId, at: new Date().toISOString(), ...(permalink && { permalink }) };
    writeFileSync(postedFile, `${JSON.stringify(posted, null, 2)}\n`);
    console.log(`posted ${key(p)} ${p.id} as ${mediaId}${permalink ? ` ${permalink}` : ""}`);
  } catch (err) {
    failed = true;
    console.error(`failed ${key(p)}: ${err.message}`);
  }
  break; // one post per run
}
process.exit(failed ? 1 : 0);
