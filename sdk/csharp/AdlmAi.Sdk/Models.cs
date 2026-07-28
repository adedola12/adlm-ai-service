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

    // ── Bill clean-up / ask / feedback ──────────────────────────────────────

    /// <summary>A bill line for the clean-up and ask features. <see cref="Ref"/> is the
    /// caller's own row handle — findings come back keyed by it, so an answer maps to a
    /// row without matching on description text.</summary>
    public sealed class BillItem
    {
        [JsonPropertyName("ref")] public string Ref { get; set; }
        [JsonPropertyName("section")] public string Section { get; set; }
        [JsonPropertyName("description")] public string Description { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("quantity")] public double Quantity { get; set; }
        [JsonPropertyName("rate")] public double Rate { get; set; }
        /// <summary>Breakdown sub-items are costed but not billed on their own, so the
        /// clean-up pass skips them.</summary>
        [JsonPropertyName("isSubItem")] public bool IsSubItem { get; set; }
    }

    /// <summary>A bill description the QS wrote themselves, overriding what the take-off
    /// produced. Sent so the service can learn this firm's house style — it is the clearest
    /// statement of their wording available. Stored strictly per tenant.</summary>
    public sealed class BillSpecification
    {
        /// <summary>The raw take-off wording it replaced.</summary>
        [JsonPropertyName("source")] public string Source { get; set; }
        /// <summary>What the QS wrote instead.</summary>
        [JsonPropertyName("specification")] public string Specification { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("section")] public string Section { get; set; }
    }

    /// <summary>One proposed change. Advisory until the caller applies it.</summary>
    public sealed class BillFinding
    {
        [JsonPropertyName("id")] public string Id { get; set; }
        /// <summary>description | unit | merge | missing.</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; }
        /// <summary>The item ref this is about. Empty for a "missing" finding.</summary>
        [JsonPropertyName("itemId")] public string ItemId { get; set; }
        [JsonPropertyName("section")] public string Section { get; set; }
        [JsonPropertyName("current")] public string Current { get; set; }
        [JsonPropertyName("proposed")] public string Proposed { get; set; }
        [JsonPropertyName("rationale")] public string Rationale { get; set; }
        [JsonPropertyName("confidence")] public double Confidence { get; set; }
        [JsonPropertyName("severity")] public string Severity { get; set; }
        /// <summary>Other refs folded in by a duplicate finding.</summary>
        [JsonPropertyName("mergeWith")] public List<string> MergeWith { get; set; }
    }

    public sealed class BillCleanupResult
    {
        [JsonPropertyName("zone")] public string Zone { get; set; }
        [JsonPropertyName("checks")] public List<string> Checks { get; set; }
        [JsonPropertyName("findings")] public List<BillFinding> Findings { get; set; }
        [JsonPropertyName("escalated")] public bool Escalated { get; set; }
    }

    public sealed class BillAskResult
    {
        [JsonPropertyName("answer")] public string Answer { get; set; }
    }

    /// <summary>What the QS did with one suggestion. Only description and unit decisions
    /// teach house style — a rate flag being accepted says the rate needed a look, not that
    /// this is how the firm writes.</summary>
    public sealed class BillFeedbackDecision
    {
        [JsonPropertyName("kind")] public string Kind { get; set; }
        [JsonPropertyName("source")] public string Source { get; set; }
        [JsonPropertyName("proposed")] public string Proposed { get; set; }
        [JsonPropertyName("unit")] public string Unit { get; set; }
        [JsonPropertyName("section")] public string Section { get; set; }
        [JsonPropertyName("accepted")] public bool Accepted { get; set; }
    }

    public sealed class BillFeedbackResult
    {
        [JsonPropertyName("recorded")] public int Recorded { get; set; }
        [JsonPropertyName("accepted")] public int Accepted { get; set; }
        [JsonPropertyName("rejected")] public int Rejected { get; set; }
        [JsonPropertyName("profileRevision")] public int ProfileRevision { get; set; }
    }
}
