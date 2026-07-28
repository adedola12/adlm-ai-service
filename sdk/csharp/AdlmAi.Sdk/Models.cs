using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AdlmAi
{
    // ── Requests ────────────────────────────────────────────────────────────

    public sealed class BoqItem
    {
        [JsonPropertyName("ref")] public string Ref { get; set; }
        [JsonPropertyName("description")] public string Description { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("quantity")] public double Quantity { get; set; }
        [JsonPropertyName("rate")] public double Rate { get; set; }
    }

    public sealed class CataloguePage
    {
        /// <summary>Base64-encoded single-page image or PDF page.</summary>
        [JsonPropertyName("bytes")] public string Bytes { get; set; }
        [JsonPropertyName("mime")] public string Mime { get; set; }
    }

    // ── Rate build-up ───────────────────────────────────────────────────────

    public sealed class RateBuildup
    {
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("components")] public List<RateComponent> Components { get; set; }
        [JsonPropertyName("overheadPercent")] public double OverheadPercent { get; set; }
        [JsonPropertyName("profitPercent")] public double ProfitPercent { get; set; }
        [JsonPropertyName("netCostNgn")] public double NetCostNgn { get; set; }
        [JsonPropertyName("overheadNgn")] public double OverheadNgn { get; set; }
        [JsonPropertyName("profitNgn")] public double ProfitNgn { get; set; }
        [JsonPropertyName("rateNgn")] public double RateNgn { get; set; }
        [JsonPropertyName("notes")] public string Notes { get; set; }
    }

    public sealed class RateComponent
    {
        [JsonPropertyName("kind")] public string Kind { get; set; }
        [JsonPropertyName("name")] public string Name { get; set; }
        [JsonPropertyName("quantity")] public double Quantity { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("unitPriceNgn")] public double UnitPriceNgn { get; set; }
        [JsonPropertyName("totalNgn")] public double TotalNgn { get; set; }
        /// <summary>"library" (looked up from RateGen) or "model" (inferred).</summary>
        [JsonPropertyName("source")] public string Source { get; set; }
        [JsonPropertyName("libraryRef")] public string LibraryRef { get; set; }
    }

    // ── BoQ check ───────────────────────────────────────────────────────────

    public sealed class BoqCheckResult
    {
        [JsonPropertyName("zone")] public string Zone { get; set; }
        [JsonPropertyName("summary")] public BoqSummary Summary { get; set; }
        [JsonPropertyName("verdicts")] public List<BoqVerdict> Verdicts { get; set; }
    }

    public sealed class BoqSummary
    {
        [JsonPropertyName("items")] public int Items { get; set; }
        [JsonPropertyName("overMarket")] public int OverMarket { get; set; }
        [JsonPropertyName("underMarket")] public int UnderMarket { get; set; }
        [JsonPropertyName("inRange")] public int InRange { get; set; }
        [JsonPropertyName("mismatches")] public int Mismatches { get; set; }
    }

    public sealed class BoqVerdict
    {
        [JsonPropertyName("ref")] public string Ref { get; set; }
        /// <summary>over_market | under_market | in_range | mismatch</summary>
        [JsonPropertyName("verdict")] public string Verdict { get; set; }
        [JsonPropertyName("deviationPercent")] public double? DeviationPercent { get; set; }
        [JsonPropertyName("benchmark")] public BoqBenchmark Benchmark { get; set; }
        [JsonPropertyName("reason")] public string Reason { get; set; }
        [JsonPropertyName("source")] public string Source { get; set; }
        [JsonPropertyName("confidence")] public double Confidence { get; set; }
    }

    public sealed class BoqBenchmark
    {
        [JsonPropertyName("description")] public string Description { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("rateNgn")] public double RateNgn { get; set; }
        [JsonPropertyName("code")] public string Code { get; set; }
    }

    // ── Outliers ────────────────────────────────────────────────────────────

    public sealed class OutlierResult
    {
        [JsonPropertyName("itemsChecked")] public int ItemsChecked { get; set; }
        [JsonPropertyName("flagCount")] public int FlagCount { get; set; }
        [JsonPropertyName("flags")] public List<OutlierFlag> Flags { get; set; }
    }

    public sealed class OutlierFlag
    {
        [JsonPropertyName("ref")] public string Ref { get; set; }
        [JsonPropertyName("type")] public string Type { get; set; }
        [JsonPropertyName("reason")] public string Reason { get; set; }
        [JsonPropertyName("confidence")] public double Confidence { get; set; }
        [JsonPropertyName("source")] public string Source { get; set; }
    }

    // ── Takeoff command (QUIV natural-language assistant) ───────────────────

    public sealed class TakeoffCommandContext
    {
        [JsonPropertyName("modules")] public List<string> Modules { get; set; }
        [JsonPropertyName("levels")] public List<string> Levels { get; set; }
        [JsonPropertyName("automatable")] public List<string> Automatable { get; set; }
    }

    public sealed class TakeoffCommandResult
    {
        [JsonPropertyName("actions")] public List<TakeoffAction> Actions { get; set; }
        [JsonPropertyName("saveTo")] public List<string> SaveTo { get; set; }
        [JsonPropertyName("reply")] public string Reply { get; set; }
        [JsonPropertyName("unsupported")] public List<string> Unsupported { get; set; }
    }

    public sealed class TakeoffAction
    {
        /// <summary>Exact module key from the supplied context (e.g. "BeamQty").</summary>
        [JsonPropertyName("module")] public string Module { get; set; }
        /// <summary>Exact level name from the supplied context, or "All Floors".</summary>
        [JsonPropertyName("level")] public string Level { get; set; }
        [JsonPropertyName("type")] public string Type { get; set; }
        [JsonPropertyName("automatable")] public bool Automatable { get; set; }
    }

    // ── Budget match ────────────────────────────────────────────────────────

    public sealed class BudgetMatchRow
    {
        [JsonPropertyName("id")] public string Id { get; set; }
        [JsonPropertyName("description")] public string Description { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
    }

    public sealed class BudgetMatchCandidate
    {
        [JsonPropertyName("id")] public string Id { get; set; }
        [JsonPropertyName("name")] public string Name { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("rate")] public double Rate { get; set; }
    }

    public sealed class BudgetMatchResult
    {
        [JsonPropertyName("matches")] public List<BudgetMatch> Matches { get; set; }
        [JsonPropertyName("unmatched")] public List<string> Unmatched { get; set; }
    }

    public sealed class BudgetMatch
    {
        [JsonPropertyName("rowId")] public string RowId { get; set; }
        [JsonPropertyName("candidateId")] public string CandidateId { get; set; }
        [JsonPropertyName("candidateName")] public string CandidateName { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("rate")] public double Rate { get; set; }
        [JsonPropertyName("confidence")] public double Confidence { get; set; }
        [JsonPropertyName("reason")] public string Reason { get; set; }
    }

    // ── Catalogue ───────────────────────────────────────────────────────────

    public sealed class CatalogueResult
    {
        [JsonPropertyName("pagesProcessed")] public int PagesProcessed { get; set; }
        [JsonPropertyName("productCount")] public int ProductCount { get; set; }
        [JsonPropertyName("pass")] public int Pass { get; set; }
        [JsonPropertyName("review")] public int Review { get; set; }
        [JsonPropertyName("products")] public List<CatalogueProduct> Products { get; set; }
    }

    public sealed class CatalogueProduct
    {
        [JsonPropertyName("page")] public int Page { get; set; }
        [JsonPropertyName("name")] public string Name { get; set; }
        [JsonPropertyName("code")] public string Code { get; set; }
        [JsonPropertyName("brand")] public string Brand { get; set; }
        [JsonPropertyName("taxonomyPath")] public string TaxonomyPath { get; set; }
        [JsonPropertyName("taxonomyConfidence")] public double TaxonomyConfidence { get; set; }
        [JsonPropertyName("priceNgn")] public double? PriceNgn { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("disposition")] public string Disposition { get; set; }
        [JsonPropertyName("templateRow")] public Dictionary<string, string> TemplateRow { get; set; }
    }
}
