// Deploys the stack with parameters taken from .env — secrets never appear
// on the command line or in chat. Writes a transient samconfig.toml (which
// stays gitignored) for SAM to pick up, then removes it.
//
//   node scripts/deploy.js            (AiProvider=bedrock, the default)
//   node scripts/deploy.js anthropic  (pin every call to the direct API)
import "dotenv/config";
import { writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const provider = process.argv[2] || "bedrock";
const P = {
  MongoUri: process.env.MONGO_URI,
  RategenMongoUri: process.env.RATEGEN_MONGO_URI,
  JwtLicenseSecret: process.env.JWT_LICENSE_SECRET,
  JwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  AdminApiKey: process.env.ADMIN_API_KEY,
  AiProvider: provider,
  AnthropicApiKey: process.env.ANTHROPIC_API_KEY,
  AiProviderFallback: process.env.AI_PROVIDER_FALLBACK || "true",
  AlarmEmail: process.env.ALARM_EMAIL || "dolapo836@gmail.com",
};

// The Anthropic key is the FALLBACK path now, not the primary one, so an empty
// value is a warning rather than a hard stop — a Bedrock-only deploy is valid.
// Everything else is still load-bearing and blocks the deploy.
const OPTIONAL = new Set(["AnthropicApiKey"]);
for (const [k, v] of Object.entries(P)) {
  if (v) continue;
  if (OPTIONAL.has(k)) {
    console.warn(
      `Warning: no ${k} in .env — deploying with no fallback provider. If the Bedrock model grant lapses, every AI call fails.`,
    );
    P[k] = "";
    continue;
  }
  console.error(`Missing .env value for ${k}`);
  process.exit(1);
}

const overrides = Object.entries(P)
  .map(([k, v]) => `${k}=\\"${String(v).replace(/"/g, '\\"')}\\"`)
  .join(" ");
writeFileSync(
  "samconfig.toml",
  `version = 0.1\n[default.deploy.parameters]\nstack_name = "adlm-ai-service"\nregion = "us-east-1"\nresolve_s3 = true\ncapabilities = "CAPABILITY_IAM"\nconfirm_changeset = false\nfail_on_empty_changeset = false\nparameter_overrides = "${overrides}"\n`
);

// `sam deploy` packages from .aws-sam/build when that directory exists, and
// NEVER rebuilds it. This script did not build, so every deploy shipped
// whatever was last built by hand — on 10 Aug 2026 that was a three-day-old
// artifact, and two consecutive deploys reported UPDATE_COMPLETE while
// changing nothing at all. The stack said success, the Lambda kept the old
// code, and the only visible symptom was a feature not appearing.
//
// Build first, always. An unbuilt deploy is worse than a failed one because it
// looks like it worked.
const b = spawnSync("cmd.exe", ["/c", "sam.cmd build"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PATH: process.env.PATH + ";C:\\Program Files\\Amazon\\AWSSAMCLI\\bin" },
});
if (b.status !== 0) {
  const blog = ((b.stdout || "") + (b.stderr || "")).split(/\r?\n/);
  console.error(blog.slice(-15).join("\n"));
  console.error("sam build failed — nothing deployed.");
  process.exit(b.status ?? 1);
}
console.log("sam build OK");

try {
  const r = spawnSync("cmd.exe", ["/c", "sam.cmd deploy"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: process.env.PATH + ";C:\\Program Files\\Amazon\\AWSSAMCLI\\bin" },
  });
  const out = ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/);
  const interesting = out.filter((l) => /Successfully|Error|Failed|ROLLBACK|CREATE_COMPLETE|UPDATE_COMPLETE/i.test(l));
  console.log(interesting.join("\n") || out.slice(-10).join("\n"));
  process.exit(r.status ?? 1);
} finally {
  unlinkSync("samconfig.toml");
}
