import { createApp } from "./app.js";
import { config } from "./config/index.js";

const app = createApp();
app.listen(config.port, () => {
  console.log(`adlm-ai-service listening on http://localhost:${config.port}`);
});
