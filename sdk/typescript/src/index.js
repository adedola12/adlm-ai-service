// ADLM AI SDK — same surface as the C# SDK: rateBuildup, boqCheck, outliers,
// catalogueExtract. Never throws on service problems; every call resolves to
// { status, value, audit, disclaimer, message } so the web app degrades
// quietly when AI is off, spent, or down.
//
//   const ai = createAdlmAi({ baseUrl, getToken: () => accessToken, product: "cloud" });
//   const res = await ai.rateBuildup({ description, zone });
//   if (res.status === "success") render(res.value);

const STATUS = {
  SUCCESS: "success",
  CACHED: "cached_fallback",
  NOT_ENTITLED: "not_entitled",
  QUOTA_REACHED: "quota_reached",
  THROTTLED: "throttled",
  UNAVAILABLE: "unavailable",
  BAD_REQUEST: "bad_request",
};

export function createAdlmAi({ baseUrl, getToken, product = "cloud", maxRetries = 2, timeoutMs = 60000 }) {
  if (!baseUrl) throw new Error("baseUrl is required");
  const localCache = new Map();

  async function post(path, body) {
    const payload = JSON.stringify(body);
    const cacheKey = path + "|" + payload;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** attempt);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(baseUrl.replace(/\/$/, "") + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getToken?.() || ""}`,
            "x-adlm-product": product,
          },
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status === 200) {
          const data = await res.json();
          if (data.code === "QUOTA_REACHED") {
            return { status: STATUS.QUOTA_REACHED, message: "Monthly AI quota reached.", quota: data.quota };
          }
          const out = {
            status: STATUS.SUCCESS,
            value: data.result,
            audit: data.audit,
            disclaimer: data.disclaimer,
            cached: data.cached,
          };
          localCache.set(cacheKey, out);
          if (localCache.size > 200) localCache.delete(localCache.keys().next().value);
          return out;
        }
        if (res.status === 403) return { status: STATUS.NOT_ENTITLED, message: "AI add-on not active for this account." };
        if (res.status === 401) return { status: STATUS.NOT_ENTITLED, message: "Sign in again to use AI features." };
        if (res.status === 400) return { status: STATUS.BAD_REQUEST, message: await res.text() };
        if (res.status === 503) {
          const text = await res.text();
          if (text.includes("CREDIT_THROTTLED")) {
            return { status: STATUS.THROTTLED, message: "This AI feature is temporarily limited. Try again later." };
          }
          continue; // retry
        }
        if (res.status >= 500) continue; // retry
        return { status: STATUS.UNAVAILABLE, message: `AI service returned ${res.status}.` };
      } catch {
        // network error / timeout — retry, then degrade
      }
    }

    const cached = localCache.get(cacheKey);
    if (cached) {
      return { ...cached, status: STATUS.CACHED, message: "AI service unreachable — showing the last cached result." };
    }
    return { status: STATUS.UNAVAILABLE, message: "AI service is unreachable." };
  }

  return {
    STATUS,
    rateBuildup: ({ description, zone, unit }) => post("/api/ai/rate-buildup", { description, zone, unit }),
    boqCheck: ({ items, zone }) => post("/api/ai/boq-check", { items, zone }),
    outliers: ({ items }) => post("/api/ai/outliers", { items }),
    catalogueExtract: ({ pages, taxonomy, templateColumns }) =>
      post("/api/ai/catalogue/extract", { pages, taxonomy, templateColumns }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
