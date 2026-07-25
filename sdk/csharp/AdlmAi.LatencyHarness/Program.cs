// Phase 1 exit criterion: the latency gate.
// Calls the deployed rate-buildup endpoint 50 times from a realistic network
// and reports cold/warm p50/p95. Budget: warm p95 under ~3s for synchronous
// plugin UX. If it fails, the C# SDK integration is async-with-progress +
// client cache BY SPECIFICATION (the SDK already supports both).
//
// Usage:
//   dotnet run -- <baseUrl> <licenceToken> [count]

using System.Diagnostics;
using AdlmAi;

if (args.Length < 2)
{
    Console.WriteLine("usage: AdlmAi.LatencyHarness <baseUrl> <licenceToken> [count=50]");
    return 1;
}

var baseUrl = args[0];
var token = args[1];
var count = args.Length > 2 ? int.Parse(args[2]) : 50;

var client = new AdlmAiClient(new AdlmAiOptions
{
    BaseUrl = baseUrl,
    TokenProvider = () => token,
    Product = "latency-harness",
    MaxRetries = 0,
    EnableLocalCache = false, // measure the wire, not the SDK cache
});

// Vary descriptions so server-side cache hits and misses are both sampled.
var descriptions = new[]
{
    "225mm hollow sandcrete blockwork in cement-sand mortar (1:6)",
    "Reinforced concrete grade 25 in ground floor slab",
    "Excavation in firm soil not exceeding 1.5m deep",
    "12mm cement-sand plaster to block walls internally",
    "Emulsion paint in two coats to plastered walls",
};

var latencies = new List<(int index, long ms, bool cached, string status)>();

for (var i = 0; i < count; i++)
{
    var desc = descriptions[i % descriptions.Length];
    var sw = Stopwatch.StartNew();
    var result = await client.RateBuildupAsync(desc, zone: "south_west", unit: "m2");
    sw.Stop();
    latencies.Add((i, sw.ElapsedMilliseconds, result.Status == AiStatus.CachedFallback, result.Status.ToString()));
    Console.WriteLine($"#{i + 1,3}  {sw.ElapsedMilliseconds,6} ms  {result.Status}");
}

long P(List<long> xs, double p)
{
    var s = xs.OrderBy(x => x).ToList();
    return s[Math.Min(s.Count - 1, (int)Math.Ceiling(p * s.Count) - 1)];
}

var cold = latencies.Take(Math.Min(5, latencies.Count)).Select(l => l.ms).ToList();
var warm = latencies.Skip(Math.Min(5, latencies.Count)).Select(l => l.ms).ToList();

Console.WriteLine();
Console.WriteLine($"Requests: {latencies.Count}   Failures: {latencies.Count(l => l.status == "Unavailable")}");
Console.WriteLine($"Cold (first {cold.Count}):  p50={P(cold, 0.5)} ms  p95={P(cold, 0.95)} ms  max={cold.Max()} ms");
if (warm.Count > 0)
{
    Console.WriteLine($"Warm ({warm.Count}):        p50={P(warm, 0.5)} ms  p95={P(warm, 0.95)} ms  max={warm.Max()} ms");
    var pass = P(warm, 0.95) < 3000;
    Console.WriteLine();
    Console.WriteLine(pass
        ? "LATENCY GATE: PASS — warm p95 under 3s; synchronous plugin UX is viable."
        : "LATENCY GATE: FAIL — warm p95 over 3s; wire the plugin using async-with-progress + cached results (SDK supports both).");
    return pass ? 0 : 2;
}
return 0;
