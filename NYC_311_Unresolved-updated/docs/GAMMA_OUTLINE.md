# NYC Street Lights — Gamma Presentation Outline

Paste this file into Gamma's "Create from text" flow. Each `---` is a slide break. `Heading` lines become the slide title, bullets become the body, and `> Speaker note:` lines go in the notes panel.

Tone: editorial / civic-tech. Lean on one big number per slide. Keep it story-first, data-second.

---

## Slide 1 — Title

**A City That Never Sleeps Shouldn't Go Dark**
Closing NYC's streetlight complaint backlog by routing 311 reports to licensed local electricians — in under 60 seconds.

- NYC Street Lights Platform
- Built on 2024 NYC 311 open data + Claude Sonnet 4.5
- [Your name] · [Course / context] · April 2026

> Speaker note: Open with the hook — the streetlight is the smallest piece of civic infrastructure, and the one New Yorkers notice most when it fails. This is a story about what happens between "I reported it" and "someone fixed it."

---

## Slide 2 — The Problem, in One Sentence

**Every dark streetlight is a quiet safety gap — and 30,881 of them were reported in 2024 alone.**

- 30,881 streetlight complaints filed to NYC 311 in 2024
- Across 250,000 city-maintained lamps
- Concentrated in outer-borough residential grids
- Source: NYC OpenData 311 dataset (`erm2-nwe9`)

> Speaker note: I want the audience to feel the scale first, before we talk about who fixes what. Thirty thousand outages a year is roughly 85 a day.

---

## Slide 3 — Why Streetlights Matter

**Lighting is the cheapest public-safety intervention a city owns.**

- Federal studies link improved street lighting to measurable reductions in nighttime crime and pedestrian injuries
- Outages cluster in low-income and outer-borough census tracts — the same neighborhoods with the fewest private lighting alternatives
- Every night a lamp stays dark is a night someone walks home under it

> Speaker note: Frame the stakes. This isn't cosmetic — it's an equity issue. Acknowledge that the causal link between lighting and safety has been debated; cite it as "measurable reductions" not "proven prevention."

---

## Slide 4 — The Pain Point We Identified: The Backlog

**1 in 4 complaints citywide — and 1 in 3 in Manhattan — are still unresolved 30 days after they're filed.**

- Citywide 30-day closure rate: 76.7% → 23.3% unresolved
- Manhattan: 67.4% closed in 30 days → 32.6% unresolved (worst)
- Staten Island & Brooklyn: ~80% closed in 30 days (best)
- Complaints don't just sit — they get re-filed, merged, lost, or "closed" administratively without the lamp being fixed

> Speaker note: This is the core pain point. Complaints can sit in the system for weeks, sometimes years. Some get auto-closed when a duplicate is filed, which makes the backlog look smaller than it is. Be honest about that.

---

## Slide 5 — The Backlog, by Borough (2024, verified)

**The pain is unevenly distributed.**

| Borough | Complaints 2024 | Closed ≤ 30 days | Unresolved |
|---|---|---|---|
| Brooklyn | 8,639 | 80.4% | 19.6% |
| Queens | 8,571 | 76.3% | 23.7% |
| Bronx | 6,184 | 78.3% | 21.7% |
| Manhattan | 4,962 | **67.4%** | **32.6%** |
| Staten Island | 2,318 | 80.4% | 19.6% |

- Graphic 1 (volume) + Graphic 2 (closure rate) from Napkin.ai
- Data pulled live from NYC OpenData Socrata API

> Speaker note: Manhattan has the fewest complaints but the worst resolution rate. Outer boroughs file more, but get faster service. That inversion is the insight the dashboard surfaces.

---

## Slide 6 — The Opportunity: Local Vendors

**NYC already licenses 1,853 electrical contractors. Most of them never see a streetlight job.**

- DOT contracts a small pool of prime vendors for streetlight maintenance
- Meanwhile, licensed neighborhood electricians — the exact people qualified to do this work — are shut out of the pipeline
- We filtered the full NYC electrical-license roster (1,875 rows) down to 1,853 actual service contractors (dropped universities, hospitals, city agencies)

> Speaker note: This is the pivot from "fix the city" to "empower the community." Same problem, different frame.

---

## Slide 7 — Revenue Back to the Neighborhood

**An estimated $6.2M – $15.4M per year in repair revenue — currently untapped by most local shops.**

- Low estimate: $200/repair × 30,881 = **$6.18M**
- Mid estimate: $350/repair × 30,881 = **$10.81M**
- High estimate: $500/repair × 30,881 = **$15.44M**
- Graphic 3 (Napkin.ai) shows the range across boroughs

> Speaker note: Be careful here. These are *estimates* built on published NYC electrical service-call rates and 2024 311 volume — NOT actual DOT contract data. Flag that clearly. This is on the disclaimer slide too.

---

## Slide 8 — What We Built

**A 3-step platform: report → classify → dispatch. Under 60 seconds, end to end.**

1. **Report** — resident submits a streetlight complaint with zip, borough, and descriptor
2. **Classify** — in-browser cosine-similarity engine finds the 5 most similar past complaints (live from 311 + historical baked pool) and infers fault type + priority
3. **Dispatch** — Claude Sonnet 4.5 drafts a municipally-formatted work order and geo-matches it to a licensed local electrician

> Speaker note: Walk through the dashboard live if time allows. Key demo beat: the "N LIVE PULLED" pill showing the Socrata feed firing in real time.

---

## Slide 9 — How It Works (Under the Hood)

**Everything runs in the browser except the LLM call.**

- **Data layer:** NYC OpenData Socrata API (`erm2-nwe9`), browser-direct fetch with 5s abort, $limit=200
- **Classification:** hand-rolled cosine similarity over multi-hot (zip, borough, descriptor-type) vectors; date-DESC tie-break for recency bias
- **Vendor matching:** filtered NYC licensed-electrician roster, geo-scored by proximity to complaint zip
- **Work-order generation:** Claude Sonnet 4.5 via Vercel serverless function, prompted with NYC DOT formatting standards
- **Hosting:** Vercel static + one edge function

> Speaker note: Emphasize that there's no ML training involved — the classifier is deterministic. That's a *feature* for a government-facing tool: auditable, no drift, reproducible.

---

## Slide 10 — The DOT Workflow Angle

**The platform doesn't replace DOT. It accelerates the work DOT already has to approve.**

- Each work order arrives pre-formatted to NYC DOT standards
- Classification and priority are pre-assigned, so a human approver reviews instead of writing
- Licensed-vendor match is pre-vetted against the official electrical-contractor roster
- Target: same-day approval instead of multi-week queuing

> Speaker note: Position this as a *co-pilot for DOT*, not a replacement. Government tech fails when it tries to disintermediate the agency. This tries to reduce friction inside it.

---

## Slide 11 — Who It's For

**Three audiences. One dashboard.**

- **Residents** — submit a complaint in under 60 seconds, see it classified in real time
- **Local electricians** — receive pre-formatted, pre-prioritized work orders ready for DOT review
- **DOT operators** — review a structured queue instead of unstructured 311 free-text

> Speaker note: Clarifying audience is one of the rubric criteria. Hit all three explicitly.

---

## Slide 12 — Methodology & Sources

**All numbers are either Verified (live from 311) or Estimated (clearly labeled).**

- Full methodology: `public/sources.html` on the live site
- 2024 complaint volumes: direct SoQL query against `erm2-nwe9`, filtered to streetlight descriptors
- Closure rates: `date_diff_d(closed_date, created_date) ≤ 30` (and ≤ 7 for the fast-response view)
- Revenue: published NYC electrical service-call rates ($200 / $350 / $500), NOT DOT contract data
- Vendor list: NYC DCA licensed-electrician dataset, filtered to exclude 22 non-contractor institutional licensees

> Speaker note: Robustness is a grading criterion. This is the slide that earns it. Read one SoQL query aloud if the audience is technical.

---

## Slide 13 — Bias & Limitations (the honest slide)

**Where this analysis could mislead — and how we tried to contain it.**

- **Reporting bias:** 311 complaints reflect who calls 311, not where outages actually are. Wealthier, English-fluent neighborhoods over-report.
- **Closure bias:** a complaint marked "closed" in 311 doesn't always mean the lamp works; duplicates and admin closures inflate the rate.
- **Revenue bias:** $200–$500/repair is a rate-card estimate, not billed data. Real contract structures may compress margins.
- **Vendor bias:** proximity-based matching favors dense boroughs; sparse Staten Island vendors are disadvantaged.
- **Temporal bias:** 2024 only. Seasonal patterns (winter storm surges) aren't modeled.

> Speaker note: This is the slide graders look for. Don't hide the weaknesses — naming them is the methodology. "We know, and here's what we did about it."

---

## Slide 14 — What We Learned

**Three insights that surprised us.**

1. Manhattan is *fast on 7-day response* (61% closed) but *slow on 30-day closure* (67%) — the hardest cases stall there, not the easy ones.
2. The 1,875-row "electrician" list includes Columbia, NYU, and the NYPD. Vendor data needs filtering before it's usable.
3. The live-data feed was being drowned out by historical baked records in similarity search — a ranking bug we only caught because the dashboard made it visible.

> Speaker note: Brief, punchy. These are the kind of findings that show you actually engaged with the data instead of just plotting it.

---

## Slide 15 — What's Next

**Roadmap, honestly ranked.**

- **Near-term:** swap 2018–2019 baked sample for a 2023–2024 pool; recolor Napkin graphics to match brand palette; strip free-tier watermarks
- **Mid-term:** replace rate-card revenue estimates with actual DOT contract-award data (FOIL request in progress)
- **Longer-term:** pilot with one community board; add Spanish-language intake; expand to signal outages and sidewalk defects

> Speaker note: End with momentum, not a wish list. Show you've thought about what's hard, not just what's fun.

---

## Slide 16 — Closing

**Faster fixes. Stronger local economies. A brighter city — one block at a time.**

- Live dashboard: [deploy URL]
- Sources & methodology: `/sources.html`
- Built with: NYC OpenData · Claude Sonnet 4.5 · Vercel · Napkin.ai

> Speaker note: Close on the mission line from the About page. Don't take questions until you've let that line land.

---

## Appendix (optional — only if Gamma asks for more)

- Slide A1: screenshot of the dashboard's Similar-Complaints panel with the live-count pill visible
- Slide A2: screenshot of the generated work order (redacted)
- Slide A3: full vendor-filter regex and the 22 excluded institutional licensees
- Slide A4: brand palette chips (from `docs/BRAND_PALETTE.md`)
