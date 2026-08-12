/**
 * The database the ADLM website API actually reads.
 *
 * WHY THIS EXISTS
 * MONGO_URI here carries no database name. In the Mongo driver that makes
 * client.db() resolve to "test", silently and with no warning. Every script
 * that loaded compute items used client.db(), so all 26 went into "test" while
 * the website server read "adlmWeb" and correctly found nothing. The Carbon and
 * Others section was empty for every user, and nothing anywhere failed: the
 * loaders reported successful upserts, the API returned 200, and the desktop
 * cached a valid empty array.
 *
 * Never call client.db() without a name in this repo. Use this.
 */
export function webDbName() {
  return process.env.WEB_DB_NAME || "adlmWeb";
}

/**
 * @param {import("mongodb").MongoClient} client
 * @param {{ quiet?: boolean }} [opts]
 */
export function webDb(client, opts = {}) {
  const name = webDbName();
  if (!opts.quiet) console.log(`[webdb] using database "${name}"`);
  return client.db(name);
}

/**
 * True when the connection string names no database, which is the condition
 * that caused the original fault. Worth asserting in any script that writes.
 */
export function uriHasNoDbName(uri = process.env.MONGO_URI || "") {
  try {
    const afterHost = uri.split("://")[1].split("/").slice(1).join("/");
    return !afterHost.split("?")[0];
  } catch {
    return true;
  }
}
