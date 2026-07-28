// Deploys the stack with parameters taken from .env — secrets never appear
// on the command line or in chat. Writes a transient samconfig.toml (which
// stays gitignored) for SAM to pick up, then removes it.
//
//   node scripts/deploy.js            (AiProvider=anthropic, current default)
//   node scripts/deploy.js bedrock    (switch provider once Bedrock unblocks)
import "dotenv/config";
import { writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const provider = process.argv[2] || "anthropic";
const P = {
  MongoUri: process.env.MONGO_URI,
  RategenMongoUri: process.env.RATEGEN_MONGO_URI,
  JwtLicenseSecret: process.env.JWT_LICENSE_SECRET,
  JwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  AdminApiKey: process.env.ADMIN_API_KEY,
  AiProvider: provider,
  AnthropicApiKey: process.env.ANTHROPIC_API_KEY,
  AlarmEmail: process.env.ALARM_EMAIL || "dolapo836@gmail.com",
};
for (const [k, v] of Object.entries(P)) {
  if (!v) { console.error(`Missing .env value for ${k}`); process.exit(1); }
}

const overrides = Object.entries(P)
  .map(([k, v]) => `${k}=\\"${String(v).replace(/"/g, '\\"')}\\"`)
  .join(" ");
writeFileSync(
  "samconfig.toml",
  `version = 0.1\n[default.deploy.parameters]\nstack_name = "adlm-ai-service"\nregion = "us-east-1"\nresolve_s3 = true\ncapabilities = "CAPABILITY_IAM"\nconfirm_changeset = false\nfail_on_empty_changeset = false\nparameter_overrides = "${overrides}"\n`
);

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
