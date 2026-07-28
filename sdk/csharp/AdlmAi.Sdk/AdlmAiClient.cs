using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace AdlmAi
{
    /// <summary>
    /// Async-first client for the ADLM AI Service. Never throws on service
    /// problems — every call returns an AiResult with a status the plugin can
    /// show. Degradation ladder: fresh → local cached result → Unavailable.
    /// </summary>
    public sealed class AdlmAiClient : IDisposable
    {
        private static readonly JsonSerializerOptions JsonOpts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };

        private readonly AdlmAiOptions _options;
        private readonly HttpClient _http;
        private readonly ConcurrentDictionary<string, string> _localCache =
            new ConcurrentDictionary<string, string>();

        public AdlmAiClient(AdlmAiOptions options, HttpClient httpClient = null)
        {
            _options = options ?? throw new ArgumentNullException(nameof(options));
            if (string.IsNullOrWhiteSpace(options.BaseUrl))
                throw new ArgumentException("BaseUrl is required", nameof(options));
            _http = httpClient ?? new HttpClient();
            _http.Timeout = options.Timeout;
        }

        // ── Feature surface (same as the TypeScript SDK) ────────────────────

        public Task<AiResult<RateBuildup>> RateBuildupAsync(
            string description, string zone = null, string unit = null,
            IProgress<string> progress = null, CancellationToken ct = default)
        {
            return PostAsync<RateBuildup>(
                "/api/ai/rate-buildup",
                new Dictionary<string, object> { { "description", description }, { "zone", zone }, { "unit", unit } },
                progress, ct);
        }

        public Task<AiResult<BoqCheckResult>> BoqCheckAsync(
            IEnumerable<BoqItem> items, string zone = null,
            IProgress<string> progress = null, CancellationToken ct = default)
        {
            return PostAsync<BoqCheckResult>(
                "/api/ai/boq-check",
                new Dictionary<string, object> { { "items", items }, { "zone", zone } },
                progress, ct);
        }

        public Task<AiResult<OutlierResult>> OutliersAsync(
            IEnumerable<BoqItem> items,
            IProgress<string> progress = null, CancellationToken ct = default)
        {
            return PostAsync<OutlierResult>(
                "/api/ai/outliers",
                new Dictionary<string, object> { { "items", items } },
                progress, ct);
        }

        public Task<AiResult<TakeoffCommandResult>> TakeoffCommandAsync(
            string prompt, TakeoffCommandContext context,
            IProgress<string> progress = null, CancellationToken ct = default)
        {
            return PostAsync<TakeoffCommandResult>(
                "/api/ai/takeoff-command",
                new Dictionary<string, object> { { "prompt", prompt }, { "context", context } },
                progress, ct);
        }

        public Task<AiResult<BudgetMatchResult>> BudgetMatchAsync(
            IEnumerable<BudgetMatchRow> rows, IEnumerable<BudgetMatchCandidate> candidates,
            IProgress<string> progress = null, CancellationToken ct = default)
        {
            return PostAsync<BudgetMatchResult>(
                "/api/ai/budget-match",
                new Dictionary<string, object> { { "rows", rows }, { "candidates", candidates } },
                progress, ct);
        }

        public Task<AiResult<CatalogueResult>> CatalogueExtractAsync(
            IEnumerable<CataloguePage> pages,
            IEnumerable<string> taxonomy = null,
            IEnumerable<string> templateColumns = null,
            IProgress<string> progress = null, CancellationToken ct = default)
        {
            return PostAsync<CatalogueResult>(
                "/api/ai/catalogue/extract",
                new Dictionary<string, object>
                {
                    { "pages", pages }, { "taxonomy", taxonomy }, { "templateColumns", templateColumns }
                },
                progress, ct);
        }

        // ── Core request path ───────────────────────────────────────────────

        private async Task<AiResult<T>> PostAsync<T>(
            string path, Dictionary<string, object> body,
            IProgress<string> progress, CancellationToken ct)
        {
            var payload = JsonSerializer.Serialize(body, JsonOpts);
            var cacheKey = path + "|" + payload;

            for (var attempt = 0; attempt <= _options.MaxRetries; attempt++)
            {
                try
                {
                    if (attempt > 0)
                    {
                        progress?.Report($"Retrying ({attempt}/{_options.MaxRetries})...");
                        await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)), ct).ConfigureAwait(false);
                    }
                    else
                    {
                        progress?.Report("Contacting ADLM AI...");
                    }

                    using (var request = new HttpRequestMessage(HttpMethod.Post, _options.BaseUrl.TrimEnd('/') + path))
                    {
                        var token = _options.TokenProvider?.Invoke();
                        if (!string.IsNullOrEmpty(token))
                            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
                        request.Headers.TryAddWithoutValidation("x-adlm-product", _options.Product ?? "unknown");
                        request.Content = new StringContent(payload, Encoding.UTF8, "application/json");

                        using (var response = await _http.SendAsync(request, ct).ConfigureAwait(false))
                        {
                            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                            var mapped = MapResponse<T>(response.StatusCode, text, cacheKey);
                            if (mapped != null) return mapped;
                            // null => retryable (5xx); loop continues
                        }
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw; // caller-initiated cancellation is the one thing we surface
                }
                catch (Exception)
                {
                    // network failure — retry, then degrade
                }
            }

            return Degrade<T>(cacheKey);
        }

        private AiResult<T> MapResponse<T>(HttpStatusCode status, string text, string cacheKey)
        {
            if (status == HttpStatusCode.OK)
            {
                try
                {
                    using (var doc = JsonDocument.Parse(text))
                    {
                        var root = doc.RootElement;
                        if (root.TryGetProperty("code", out var codeEl) &&
                            codeEl.GetString() == "QUOTA_REACHED")
                        {
                            return AiResult<T>.Of(AiStatus.QuotaReached,
                                "Monthly AI quota reached. It resets at the start of next month.");
                        }

                        var result = AiResult<T>.Of(AiStatus.Success);
                        if (root.TryGetProperty("result", out var resultEl))
                            result.Value = JsonSerializer.Deserialize<T>(resultEl.GetRawText(), JsonOpts);
                        if (root.TryGetProperty("audit", out var auditEl))
                            result.Audit = JsonSerializer.Deserialize<AiAudit>(auditEl.GetRawText(), JsonOpts);
                        if (root.TryGetProperty("disclaimer", out var discEl))
                            result.Disclaimer = discEl.GetString();

                        if (_options.EnableLocalCache && result.Value != null)
                        {
                            if (_localCache.Count >= _options.LocalCacheSize) _localCache.Clear();
                            _localCache[cacheKey] = text;
                        }
                        return result;
                    }
                }
                catch (JsonException)
                {
                    return AiResult<T>.Of(AiStatus.Unavailable, "Unexpected response from AI service.");
                }
            }

            if (status == HttpStatusCode.Forbidden)
                return AiResult<T>.Of(AiStatus.NotEntitled,
                    "AI add-on not active for this account. Available on adlmnigeria.com.");
            if (status == HttpStatusCode.Unauthorized)
                return AiResult<T>.Of(AiStatus.NotEntitled, "Sign in again to use AI features.");
            if (status == HttpStatusCode.BadRequest)
                return AiResult<T>.Of(AiStatus.BadRequest, text);
            if (status == HttpStatusCode.ServiceUnavailable)
            {
                // Credit-guard throttle is a distinct, honest state.
                if (text.Contains("CREDIT_THROTTLED"))
                    return AiResult<T>.Of(AiStatus.Throttled,
                        "This AI feature is temporarily limited. Please try again later.");
                return null; // retry
            }
            if ((int)status >= 500) return null; // retry
            return AiResult<T>.Of(AiStatus.Unavailable, $"AI service returned {(int)status}.");
        }

        private AiResult<T> Degrade<T>(string cacheKey)
        {
            if (_options.EnableLocalCache && _localCache.TryGetValue(cacheKey, out var cachedText))
            {
                var mapped = MapResponse<T>(HttpStatusCode.OK, cachedText, cacheKey);
                if (mapped != null && mapped.Status == AiStatus.Success)
                {
                    mapped.Status = AiStatus.CachedFallback;
                    mapped.Message = "AI service unreachable — showing the last cached result.";
                    return mapped;
                }
            }
            return AiResult<T>.Of(AiStatus.Unavailable,
                "AI service is unreachable. The plugin continues to work without AI.");
        }

        public void Dispose() => _http.Dispose();
    }
}
