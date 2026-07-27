using System;

namespace AdlmAi
{
    public enum AiStatus
    {
        /// <summary>Fresh result from the AI service.</summary>
        Success,
        /// <summary>Served from the SDK's local cache (service unreachable or identical repeat call).</summary>
        CachedFallback,
        /// <summary>The account has no active AI add-on entitlement. Show an upgrade message.</summary>
        NotEntitled,
        /// <summary>Monthly AI quota reached. Show quota info; base plugin keeps working.</summary>
        QuotaReached,
        /// <summary>Feature temporarily throttled by the platform credit guard.</summary>
        Throttled,
        /// <summary>Service unreachable and nothing cached. Degrade quietly.</summary>
        Unavailable,
        /// <summary>Request was invalid (caller bug).</summary>
        BadRequest
    }

    /// <summary>
    /// Every SDK call returns an AiResult instead of throwing, so a plugin can
    /// always keep its base functionality when AI is off, spent, or down.
    /// </summary>
    public sealed class AiResult<T>
    {
        public AiStatus Status { get; internal set; }
        public T Value { get; internal set; }
        /// <summary>Model, confidence, data version — show alongside verdicts.</summary>
        public AiAudit Audit { get; internal set; }
        /// <summary>Advisory disclaimer that must be displayed with verdicts.</summary>
        public string Disclaimer { get; internal set; }
        public string Message { get; internal set; }
        public bool IsSuccess => Status == AiStatus.Success || Status == AiStatus.CachedFallback;

        internal static AiResult<T> Of(AiStatus status, string message = null) =>
            new AiResult<T> { Status = status, Message = message };

        /// <summary>Public factory for hosts that need a local not-configured result.</summary>
        public static AiResult<T> Unavailable(string message) =>
            new AiResult<T> { Status = AiStatus.Unavailable, Message = message };
    }

    public sealed class AiAudit
    {
        public string Model { get; set; }
        public double? Confidence { get; set; }
        public string DataVersion { get; set; }
        public string PromptVersion { get; set; }
    }

    public sealed class AdlmAiOptions
    {
        /// <summary>Base URL of the AI service, e.g. https://xxxx.execute-api.us-east-1.amazonaws.com</summary>
        public string BaseUrl { get; set; }
        /// <summary>Licence JWT obtained from ADLM Cloud login (plugins) or access token (web).</summary>
        public Func<string> TokenProvider { get; set; }
        /// <summary>Product identifier for usage attribution: quiv | heron | rategen.</summary>
        public string Product { get; set; } = "unknown";
        public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(60);
        public int MaxRetries { get; set; } = 2;
        /// <summary>Keep last-known-good results per input for quiet degradation.</summary>
        public bool EnableLocalCache { get; set; } = true;
        public int LocalCacheSize { get; set; } = 200;
    }
}
