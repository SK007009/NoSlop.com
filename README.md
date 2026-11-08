# NoSlop.com

**Dynamic Brand Governance & Claim Verification — 100% Client-Side**
Team Kaizen • Solo developer: **Satyam** • Round 2 submission

NoSlop.com turns *any* unstructured brand guideline — a brand book PDF, a legal
memo, a pasted wiki page — into an executable rule "vault", then audits any ad
copy or banner image against it before publication. Every finding cites the line
of the guideline it came from, offers a one-click surgical rewrite, and can be
escalated through a role-gated approval workflow whose human overrides feed back
into the guideline itself.

No cloud LLM. No API keys. No telemetry. Document parsing, OCR, claim matching,
and WCAG contrast math all run inside the browser tab.

---

## 0. The 90-second judge tour

1. `npm install && npm run dev` → open the printed localhost URL.
2. **Tab 1** — upload any brand/legal PDF. Watch hex colours, banned terms, and
   numeric facts compile into the vault, each with a page/line citation.
3. **Tab 2** — paste any ad copy, optionally attach a banner PNG/JPG, press
   **Run Pre-Flight Brand Governance Audit**. Issues arrive with severity,
   citation, and a suggested fix; **Apply Surgical Fix** rewrites the draft and
   the diff viewer shows the exact words that changed.
4. **Tab 2** — **Request Exception Override** on an issue you disagree with and
   type a justification.
5. **Tab 4** — the **Ambiguous Guideline Auto-Refiner** now lists that rule with
   your justification; **Update Brand Rule in Vault** writes the clarification
   into the live vault. Re-run the audit and the terminology reflects it.
6. **Tab 5** — type the **Authorized Signer Name**, then **Download Signed PDF
   Certificate (.pdf)**: a formatted A4 certificate carrying the trust score,
   workflow status, privacy attestation, remediated copy, initials stamp and a
   real Web Crypto SHA-256 seal. The **Export Raw Audit Log (.json)** button
   still produces the machine-readable receipt.

A seeded NovaPay guideline + ad draft loads on first paint so nothing is empty.

---

## 1. Product Architecture & Main Technical Decisions

### 1.1 The neuro-symbolic split

The product is deliberately *neuro-symbolic*: a neural component handles
perception (pixels → text), and a symbolic component handles judgement
(text → violations), with a shared, inspectable data contract between them.

| Layer | Component | Why it exists |
|---|---|---|
| **Perception (neural)** | `tesseract.js` LSTM OCR (WASM) extracts strings from the banner | Reading stylised ad artwork is a pattern-recognition problem regexes cannot solve |
| **Perception (numeric)** | HTML5 Canvas pixel sampling: dominant-colour mining + per-region luminance + tile contrast fallback | Colour and contrast are measured, not guessed |
| **Perception (linguistic)** | `compromise` POS/noun tagging during guideline parsing | Turns prose sentences into keyed facts without an LLM |
| **Reasoning (symbolic)** | Regex word-boundary rule matching, `fuse.js` fuzzy fact retrieval, numeric-token comparison, WCAG 2.1 contrast formula, CIELAB ΔE₇₆ | Deterministic, replayable, and every verdict can cite its own rule |
| **Composition** | One `Issue` schema for text, OCR, and visual findings | A single remediation surface; no "image findings" second-class citizen |

The deliberate absence is the generative model. A brand-compliance verdict must
be **defensible**: "flagged because rule `RULE-T1` from *NovaPay Brand Book 2026
(Page 3)* says 'cheap' → 'cost-effective'" survives a legal review; "flagged
because the model felt it was off-brand" does not. Removing the LLM also removes
the data-egress problem entirely — which is the whole pitch to an agency whose
drafts are confidential.

### 1.2 The pipeline

```
        PDF ─► pdfjs-dist text ─┐
                                ├─► parseRawGuidelines() ─► BRAND VAULT ─┐
   pasted prose ────────────────┘      (regex + compromise)              │
                                                                         ▼
   ad copy ────────────────────────────────────────► auditAdText() ─► ISSUE[]
                                                                         │
   banner image ─► canvas pixels ──► palette/luminance ─┐                │
                └► tesseract OCR ─► text ──────────────┴► auditAdImage() ┘
                                                                         │
                                                    React state: issues, overrides,
                                                    revisionHistory, workflowStatus
                                                                         │
                    ┌────────────────────────────┬───────────────────────┴────────┐
                    ▼                            ▼                                ▼
      Surgical Fix (jsdiff diff)      Role-gated sign-off (Tab 3)      Refiner + receipt (Tab 4)
```

### 1.3 Data contracts

Everything downstream depends on these three shapes, defined in
`src/utils/guidelineParser.js` and `src/utils/auditEngine.js`:

```js
// Brand Vault — the compiled, inspectable rule set
{
  sourceName: 'NovaPay_Brand_Book_2026.pdf',
  rawText: '...',
  colors:       [{ id: 'CLR-1', name, hex: '#2563EB', source }],
  bannedTerms:  [{ id: 'RULE-T1', term: 'cheap', replacement: 'cost-effective',
                   reason, citation }],
  facts:        [{ id: 'FACT-1', statement, numbers: ['99.9%'],
                   keywords, citation }],
  minContrastRatio: 4.5
}

// Issue — one finding, regardless of whether it came from text, OCR, or pixels
{
  id: 'ISS-T-1',            // or ISS-F-*, ISS-C-*, ISS-S-*, ISS-TONE-*,
                            // VIS-CLR-1, VIS-WCAG-*, OCR-ISS-*
  ruleId: 'RULE-T1',        // the vault rule (or a built-in policy id) that fired
  category: 'Terminology Violation',
  severity: 'High' | 'Medium' | 'Low',
  offendingText, explanation, citation,
  suggestedFix            // already surgical — a drop-in replacement
}

// ImageReport — returned by auditAdImage()
{ dominantColors: [{ r, g, b, hex }], ocrText, boundingBoxes: [...],
  lowContrastRegions: [...], issues: [] }
```

`ruleId` is the join key that makes Round 2's analytics possible: it is written
into every issue, carried into each override, and used in Tab 4 to resolve the
same rule back out of the vault.

### 1.4 Main technical decisions

| Decision | Rationale | Accepted trade-off |
|---|---|---|
| **No LLM at runtime** | Deterministic, court-defensible verdicts; zero data egress; no per-seat cost | Semantic paraphrase detection is limited to regex + fuzzy matching |
| **All compute in the browser** | Confidential drafts never leave the machine — the reason agencies can adopt it at all | OCR is CPU-bound; first run downloads the language model |
| **Rules carry their own citation** | Every flag is traceable to `source (Page n, Line m)` — the core trust mechanism | Parser is regex-heuristic and can miss unusual guideline phrasing |
| **One `Issue` schema for text + image + OCR** | Reviewers see one prioritised queue instead of three tools | Visual findings borrow the textual remediation model (`suggestedFix` strings) |
| **Human override requires a written justification** | A rule cannot be silently bypassed; the justification becomes training data for guideline refinement | Uses the blocking `window.prompt()` dialog |
| **Overrides grouped by `ruleId` (Round 2)** | Turns a pile of one-off exceptions into a ranked list of ambiguous guidelines | Issue ids are positional, so ids shift between audit runs (see §6) |
| **Tailwind v4 utilities only, no component library** | Small, auditable dependency surface and instant styling | Verbose markup; the whole UI lives in one file |
| **Single `App.jsx` holding all state** | Fastest path to a coherent 4-tab demo under hackathon time pressure | ~900 lines; candidate for the first refactor in Round 3 |

### 1.5 File map

```
src/
├── App.jsx                    4-tab workspace, all state, workflow, refiner
├── main.jsx                   React 19 root + StrictMode
├── index.css                  Tailwind v4 entry (@import "tailwindcss")
├── utils/
│   ├── guidelineParser.js     PDF text extraction + guideline → vault compiler
│   └── auditEngine.js         Text audit, canvas colour/contrast, OCR audit
├── App.css                    UNUSED — Vite template leftover
└── assets/                    UNUSED — template svgs
public/                        favicon.svg, icons.svg
index.html                     Vite entry
vite.config.js                 react() + tailwindcss() plugins
```

---

## 2. Complete Open-Source Disclosure

### 2.1 Runtime libraries (direct dependencies)

| Library | Version | License | Role in NoSlop.com |
|---|---|---|---|
| `react`, `react-dom` | 19.3.1 | MIT | UI runtime and state |
| `vite` | 8.3.5 | MIT | Dev server + production bundler |
| `@vitejs/plugin-react` | 6.2.1 | MIT | JSX transform, Fast Refresh |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.4 | MIT | Utility-first styling |
| `lucide-react` | 1.68.0 | ISC | Icon set |
| `diff` (jsdiff) | 9.0.0 | BSD-3-Clause | `diffWords()` for the surgical diff viewer |
| `fuse.js` | 7.5.0 | Apache-2.0 | Fuzzy retrieval of the fact that a claim contradicts |
| `compromise` | 14.19.0 | MIT | Noun/POS tagging when indexing guideline facts |
| `pdfjs-dist` | 6.5.438 | Apache-2.0 | PDF text extraction (bundled worker, CDN fallback) |
| `tesseract.js` | 7.0.0 | Apache-2.0 | LSTM OCR of banner artwork (WASM) |
| `tesseract.js-core` | 7.0.0 | Apache-2.0 | Tesseract WASM/JS core (transitive) |

Dev-only tooling: `eslint` 10, `@eslint/js`, `eslint-plugin-react-hooks`,
`eslint-plugin-react-refresh`, `globals`. None of it ships in the bundle.

Transitive dependencies of the above (e.g. `wasm-feature-detect`, `idb-keyval`,
`bmp-js`, `zlibjs`, `node-fetch`) are pulled in by the published packages. A
complete, machine-generated inventory:

```bash
npx license-checker --summary
```

### 2.2 Algorithms implemented (and where)

| Algorithm | Implementation | Location |
|---|---|---|
| Hex colour mining | `/#(?:[0-9a-fA-F]{6}\|[0-9a-fA-F]{3})\b/g`, de-duplicated | `guidelineParser.js` |
| Replacement-directive parsing | Single regex over "instead of X, use Y / replace X with Y / rather than / do not use / never use / avoid" | `guidelineParser.js` |
| Prohibited-term extraction | Prohibitive-verb gate + quoted-word matches + colon-list split | `guidelineParser.js` |
| Fact/metric indexing | Numeric+unit regex → `compromise` noun extraction → keyword blob | `guidelineParser.js` |
| Anti-slop baseline | 4 hardcoded universal rules (`delve`, `testament to`, `game-changing`, `tapestry`) merged into every vault | `guidelineParser.js` |
| Word-boundary term matching | `new RegExp('\\b' + escaped + '\\b', 'gi')`, all occurrences | `auditEngine.js` |
| Fuzzy claim retrieval | `fuse.js` Bitap over `statement` + `keywords`, `threshold: 0.6` | `auditEngine.js` |
| Numeric contradiction check | Token equality after whitespace normalisation, per sentence | `auditEngine.js` |
| Superlative/absolute claim gate | Word-list regex (`100%`, `#1`, `guaranteed`, `instant`, …) | `auditEngine.js` |
| ALL-CAPS tone check | `/\b[A-Z]{5,}\b/g`, flagged at ≥ 2 occurrences per sentence | `auditEngine.js` |
| WCAG 2.1 relative luminance | sRGB linearisation (`c ≤ 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`), `0.2126 R + 0.7152 G + 0.0722 B` | `auditEngine.js` |
| WCAG contrast ratio | `(Lbright + 0.05) / (Ldark + 0.05)`, threshold `minContrastRatio` (4.5) | `auditEngine.js` |
| Dominant-colour mining | Per-channel quantisation to 24-step buckets over a stride-sampled pixel array, top 4 | `auditEngine.js` |
| Palette deviation | sRGB → XYZ → CIELAB (D65), CIE76 `ΔE = √(ΔL² + Δa² + Δb²)`; flagged when the nearest palette colour is > 28 away | `auditEngine.js` |
| OCR word extraction | `createWorker('eng')` + `recognize(img, {}, { blocks: true })`, flattened `blocks → paragraphs → lines → words`, worker terminated in `finally` | `auditEngine.js` |
| Per-word WCAG sampling | Darkest / lightest luminance across the whole word box, ratio `< minContrastRatio` → `VIS-WCAG-*` | `auditEngine.js` |
| Low-contrast tile fallback | 16-column tile scan when OCR resolves < 2 words or its worst word sits below 1.6:1; tiles with tone span 0.02–0.4, a sharp edge, and ratio < 4.5 raise one `VIS-WCAG-TILE-1` — only if no word-level finding already fired | `auditEngine.js` |
| Word-level diff | Myers-style word diff via `jsdiff`'s `diffWords` | `App.jsx` |
| Override clustering | Group overrides by `ruleId`, aggregate justifications | `App.jsx` (`overrideGroups`) |
| Replacement inference | Quoted-phrase match, then directive match ("use/say/prefer …"), else keep existing | `App.jsx` (`suggestRefinedReplacement`) |
| Trust score | `max(0, 100 − 14 × unresolved issues)` | `App.jsx` |

Notes on honesty of naming: the palette distance is a genuine perceptual
**CIE76 ΔE computed in CIELAB (D65)** — `rgbToLab()` then the Euclidean distance
in L\*a\*b\*, not the Euclidean RGB proxy the UI used to mislabel as `ΔE`. Per-word
contrast takes the darkest and lightest pixel across the whole word box rather
than a single sampled pixel. The residual blind spot — text so close to its
background that OCR cannot read it at all — is handled by the tile fallback and
documented in §6.

### 2.3 What is deliberately *not* used

- **No cloud LLM / generative API** — no OpenAI, Gemini, Anthropic, or any hosted
  inference call in `src/`.
- **No API keys or secrets** of any kind in the repository.
- **No analytics, telemetry, fonts, or CDNs at runtime**, with two narrow
  exceptions listed below.

Judge-verifiable:

```bash
grep -RniE "openai|gemini|anthropic|api[_-]?key|sk-[A-Za-z0-9]{20,}|bearer " src/ \
  || echo "CLEAN: no cloud AI credentials or SDK references in src/"
grep -rn "fetch(" src/ || echo "CLEAN: no fetch() calls in src/"
```

Both currently print the `CLEAN` line.

The two network touch-points that do exist, both inbound assets rather than data
uploads:

1. `pdfjs-dist` worker — bundled locally via Vite's `new URL(..., import.meta.url)`;
   an unpkg CDN URL is used **only** if that resolution throws.
2. `tesseract.js` — on the first OCR run, the browser downloads the English
   LSTM model (`tessdata`, a few MB) from the Tesseract CDN, then caches it. No
   image, text, or draft is uploaded; the request is a plain GET for a model
   file.

### 2.4 FreeBuff CLI usage disclosure

This repository was built with the **FreeBuff CLI** (Codebuff agent, build mode)
as a *development-time* coding assistant. Its role was confined to the
development loop:

- writing and refactoring React/JSX in `src/App.jsx` and the two `src/utils/`
  modules;
- running verification commands (`npm run build`, `npx eslint src/App.jsx`) and
  browser smoke tests against the local dev server;
- producing this README.

It is **not** shipped, imported, or called by the application: there is no agent
SDK in `package.json`, no network call to any AI service, and no runtime
dependency on FreeBuff. The product's intelligence is entirely the deterministic
parser + audit engine described in §1–2. No paid cloud API keys are used
anywhere, per the Round 2 rule.

---

## 3. End-to-End Judge Test Runbook

### 3.1 Setup

Requirements: **Node.js 20.19+ or 22.12+** (Vite 8 requirement) and a modern
Chromium/Firefox/Safari.

```bash
npm install
npm run dev          # → http://localhost:5173
```

Production sanity check (must exit 0):

```bash
npm run build        # vite build → dist/
npm run preview      # serve the built bundle
```

Scripts: `dev`, `build`, `lint`, `preview` (see `package.json`).

Testing tip: use an **incognito/private window** so the Tesseract model cache
state is predictable, and keep the DevTools **Network** tab open during the first
OCR run.

### 3.2 Test A — Any random **PDF** guideline

1. Open **Tab 1 · Brand Guideline Compiler**.
2. Click **Upload PDF / TXT** and pick any text-based PDF — your own brand book,
   a vendor security policy, a marketing style guide, or any web page printed to
   PDF. (Scanned/image-only PDFs contain no text layer — see §6.)
3. The textarea fills with `[Page n] …` markers and the vault compiles
   automatically.

**Expect**, in the three right-hand cards:

- **Brand Hex Palette** — one chip per unique `#RRGGBB`/`#RGB` found in the
  document (falls back to a default blue/emerald pair if the document has none).
- **Banned Terms & Surgical Replacements** — "instead of X, use Y" sentences
  become `"x" → "y"` rules; prohibitive sentences yield quoted words; always
  appended are the 4 universal anti-slop rules (`delve`, `testament to`,
  `game-changing`, `tapestry`).
- **Approved Facts & Metrics Ledger** — sentences containing numbers become
  facts with **Pinned Metrics** extracted (`99.9%`, `256-bit`, `45`, …).
- Every rule shows a **citation** with page/line, e.g.
  `yourfile.pdf (Page 2, Line 7)`.

### 3.3 Test B — Random **raw text** guideline + arbitrary ad copy

1. **Tab 1** → clear the textarea, paste any prose you like, e.g.:

   ```
   Acme Fitness Brand Rules
   Official colours are #FF6B00 and #1A1A1A.
   Instead of "shredded", use "lean strength".
   Never use the words "guaranteed", "instant", or "miracle".
   Members lose an average of 6 kg in 12 weeks across 30 studios.
   ```

2. Press **Compile Guidelines into Active Rules** (watch the revision log grow).
3. Go to **Tab 2**, replace the draft with something like
   `Instant results guaranteed — lose 10 kg in 12 weeks, no effort!`
4. Press **Run Pre-Flight Brand Governance Audit**.

**Expect:** a mix of `Terminology Violation` (instant), `Unsupported Promotional
Claim` / `Contradictory Fact / Claim` (the 10 kg vs 6 kg contradiction is
detected by fuzzy fact retrieval and numeric comparison), plus severity, rule
citation, the offending substring, and a suggested fix per card.

5. Press **Apply Surgical Fix** on the fact contradiction → the draft text is
   rewritten (10 kg → 6 kg), the issue disappears, the **Intent-Preserving
   Surgical Diff** highlights removed/added words in red/green, and the
   **Brand Trust Score** rises by 14 points per resolved issue.

### 3.4 Test C — Banner image (palette + OCR)

1. **Tab 2** → **Browse Image** → choose any ad banner PNG/JPG (a designed
   creative with text works best: 800–1600 px wide).
2. Press **Run Pre-Flight Brand Governance Audit**; the button reports
   `Running Multimodal Audit (n%)…` while OCR streams progress.
3. **Expect:**
   - **Extracted Banner Colors** — up to 4 dominant hex chips mined from the
     canvas.
   - `Visual Brand Consistency` issue when the dominant colour is far (> 90 RGB
     distance) from the nearest approved palette colour, citing that palette
     entry as its source.
   - Any guideline violations found in the artwork's text appear as
     `Image OCR: <category>` issues, prefixed `[Found in Banner Graphic]`.
4. First run only: the OCR model downloads (a few MB) and the browser caches it;
   subsequent runs start immediately. See §6 for the per-word WCAG caveat.

### 3.5 Test D — Governance, overrides, and roles

1. In **Tab 2**, press **Request Exception Override** on any issue and enter a
   justification (a `window.prompt` dialog appears; it is required).
2. The issue card flips to an amber "Override Requested" state and the trust
   score stops counting it as unresolved.
3. Switch **Active Role** in the header to **Brand Manager**.
4. **Tab 3** → **Approve Publication (Brand Manager)**. As `Creator` the button
   is disabled with an explanatory banner; as Brand Manager or Legal Reviewer it
   works.
5. Post a review comment; the **Immutable Revision & Audit History** panel
   records compilation, audits, fixes, overrides, refinements, and approvals with
   timestamps and actor names.

### 3.6 Test E — Tab 4: drift analytics & auto-refiner; Tab 5: signed certificate

1. With at least one override from Test D, open **Tab 4**.
2. **Guideline Ambiguity & Drift Analytics** shows source name, rule/fact counts,
   and overrides logged.
3. **Ambiguous Guideline Auto-Refiner** lists every overridden rule grouped by
   `ruleId`, showing the rule's current definition and **every** justification
   with the reviewer and issue id. Policy-only checks (`CLAIM-UNVERIFIED`, `CLAIM-ABSOLUTE`,
   `TONE-CAPS`, `WCAG-AA`) appear but their button is disabled — they are
   synthesised by the engine, not stored in the vault.
4. Press **Update Brand Rule in Vault** → the row gains a `Refined` badge and
   "Vault now notes: …", the button becomes **Re-Sync Rule in Vault**, and a
   revision entry is written. If the justification named a replacement (e.g.
   `use "rapid settlement"` or a quoted phrase), the vault rule's replacement is
   updated too, which changes the next audit immediately. Both the replacement
   phrase and the justification are **editable inputs** above the override quotes
   before you commit — retype either one, then press **Update Brand Rule in
   Vault**, and the edited wording (not the raw override text) is what lands in
   the vault.
5. **Tab 5** — fill in **Authorized Signer Name** (defaults to
   `Satyam (Team Kaizen)`). The circular badge picks up the initials (`ST`), and
   the **Web Crypto SHA-256 Asset & Audit Seal** fills in with a 64-character
   lowercase hex digest a moment later. Edit any field or switch role and the
   digest changes: it is `crypto.subtle.digest('SHA-256', …)` over
   `{ brandVault.sourceName, workingAdText, trustScore, activeRole, signerName }`,
   computed in the tab, never fetched.
6. Press **Download Signed PDF Certificate (.pdf)**. `NoSlop-Compliance-Certificate.pdf`
   downloads immediately — one A4 page rendered at 1240 × 1754 px on an offscreen
   canvas and wrapped in a PDF by the bundled JPEG/DCTDecode writer, so no PDF
   package and no server are involved. It contains:
   - **Header banner** — charcoal `#121411` with electric-lime `#D8FF4B` accents,
     Certificate ID (`NS-` + the first ten hex characters of the digest) and the
     ISO timestamp.
   - **Summary box** — brand trust score, workflow status, compiled guideline
     source, unresolved flags, approved exception overrides.
   - **Zero-cloud attestation** — `100% On-Device Execution Verified — Zero Cloud
     LLM Calls, Zero External API Keys, Zero Telemetry.`
   - **Audited copy snapshot** — the remediated draft, wrapped to the page width,
     plus every logged override with its justification, reviewer and rule.
   - **Signature block** — `[ST]` initials stamp in a charcoal/lime seal, a script
     signature line, `Signed by: …`, the signer's role, and the engine name; on
     the right, the full 64-character SHA-256 digest in monospace.
7. The secondary **Export Raw Audit Log (.json)** button writes
   `NoSlop_Governance_Receipt.json` with `platform`, ISO `timestamp`,
   `guidelineSource`, `trustScore`, `workflowStatus`, `unresolvedFlags`,
   `approvedOverrides`, `signerName`, `signerRole`, `sha256AssetSeal`,
   `auditedCopy`, `disclosedEngines`, and
   `cloudDataLeakage: "0 bytes (100% Client-Side Execution)"`. Both artefacts are
   produced from the same state, so the JSON is the developer-facing twin of the
   PDF rather than a separate export path.

### 3.7 Test F — Robustness / adversarial input

| Input | Expected behaviour |
|---|---|
| Empty guideline textarea → Compile | No crash; vault falls back to default palette, 0 facts, and the 4 anti-slop rules |
| Guideline with no hex codes | Default 2-colour palette is used, not an empty swatch row |
| Ad copy that is pure prose, no claims | Zero issues, status `Ready for Approval`, trust score 100% |
| Ad copy with only uppercase shouting | `Tone & Accessibility` issue (ALL-CAPS ≥ 2 words) |
| Very short words / symbols only in the banner | OCR filters out tokens ≤ 2 chars and confidence ≤ 45 |
| Guideline sentences with no numbers | No fact entries; factual checks are skipped rather than guessed |

### 3.8 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| PDF upload does nothing | The PDF is image-only (no text layer) — `pdfjs-dist` returns no text. Use a text-based PDF or paste the text. |
| `Failed to fetch dynamically imported module` for the PDF worker | Offline/blocked unpkg fallback; `npm run dev` once online so Vite serves the bundled worker |
| OCR sits at 0% | First-run model download in progress (Network tab shows a `.traineddata.gz` fetch). Needs connectivity once. |
| After **Clear for Random Judge Input**, audits still cite old rules | The button clears the draft text, not the compiled vault. Press **Compile Guidelines into Active Rules** to rebuild from the (now empty) textarea. |
| Reload loses the vault, overrides, and history | Expected — all state is in memory (§6, Round 3 item 2). |
| `npx eslint src/App.jsx` reports 2 errors | Pre-existing unused imports (`React`, `AlertTriangle`); unrelated to behaviour |

### 3.9 Build verification

```bash
npm run build          # ✅ exits 0 — 2604 modules transformed
npx eslint src/App.jsx # ⚠️ 2 pre-existing no-unused-vars (see above)
```

---

## 4. Round 2

### 4.1 Three improvements delivered in Round 2

**1. Multimodal visual governance — the auditor now reads the creative, not just
the copy.**
Banner images are decoded to an HTML5 Canvas where pixel data feeds two engines:
(a) dominant-colour mining compared against the compiled palette, and (b)
`tesseract.js` OCR whose extracted strings are pushed through the *same* text
audit as the draft. Findings from all three sources are normalised into one
`Issue` schema, so a reviewer finally sees "the banner says 'risk-free' in the
artwork" and "the caption says 'risk-free'" in the same queue, with the same
citations and the same one-click fixes.

**2. A governance workflow with an evidence trail.**
Round 1 ended at "here are the problems". Round 2 adds role separation
(Creator / Brand Manager / Legal Reviewer), a publication gate that only
approvers can open, mandatory written justifications for any exception override,
a live trust score that treats overrides as accepted risk rather than hidden
failures, an append-only revision history with actor + timestamp, and a
downloadable JSON disclosure receipt that states — in a machine-readable file —
which engines ran and that zero bytes left the browser. Tab 5 pairs that JSON with
a formatted, signer-named A4 PDF certificate sealed by a real Web Crypto SHA-256
digest, so a non-technical approver can print or file the evidence without
opening a `.json` file.

**3. A closed loop from human exceptions back into the guidelines themselves.**
This is the Round 2 headline and the reason Tab 4 exists. In Round 1 an override
was a dead end: a human disagreed with a rule, and nothing about the system
learned from it. Now every override carries its `ruleId` and justification into
the **Ambiguous Guideline Auto-Refiner**, which groups them per rule, surfaces
the exact guideline text responsible, and lets a Brand Manager rewrite that rule
in the vault in one click — storing the clarification, the reviewer, and the
timestamp on the rule object, and (when the justification names one) the refined
replacement phrase. The refined rule takes effect on the very next audit, so
guideline quality improves as a by-product of normal review work.

### 4.2 Three planned improvements for Round 3

**1. Finish the visual layer: word bounding boxes and an interactive overlay.**
**1. From coarse tiles to real text regions.**
Word boxes and the red/green overlay shipped in Round 2 (§4.1), and the tile pass
now catches near-1:1 banners that OCR reads as empty — but tiles are a 16-column
grid: they cannot say *which words* are faint, and the ratio still comes from
extreme pixels rather than glyph segmentation. Round 3 replaces tiles with
connected-component region proposals and per-tile Otsu thresholding, so every
faint run of text gets its own box, its own ratio and its own finding instead of
one aggregated warning per banner.

**2. A durable, portable Brand Vault.**
Today the vault, overrides, and revision history live only in React state and
reset on reload. Round 3 adds IndexedDB persistence with an explicit
import/export of the vault as JSON (so a compiled brand book can be versioned in
git), per-campaign workspaces, and an approval history that survives sessions —
which is what turns the demo into something a team could actually run.

**3. Scale and testability.**
Three concrete gaps: issue ids are positional (`ISS-T-1`, `ISS-T-2` …) so
overrides can re-attach to a different rule after a re-parse — Round 3 moves to
stable content-hashed rule ids; judges currently need their own PDF, so a preset
library (Fintech / Healthcare / Eco-retail) will make a one-click demo possible;
and the parser + engine need a fixture suite (guideline text in, expected issues
out) so regex changes can be regression-tested like any other code.

---

## 5. Solo Developer Contribution Statement — Satyam (Team Kaizen)

> I, **Satyam**, am the sole developer of Team Kaizen's NoSlop.com Round 2
> submission. No other individual contributed code, design, or documentation to
> this repository.
>
> I owned the submission end to end:
>
> - **Product & architecture** — framing the problem as neuro-symbolic brand
>   governance, choosing a zero-egress client-side architecture, and defining the
>   Brand Vault / Issue / ImageReport contracts that every feature depends on.
> - **`src/utils/guidelineParser.js`** — PDF/TXT ingestion and the guideline
>   compiler: hex-colour mining, replacement-directive and prohibited-term
>   extraction, the fact ledger (numeric regex + `compromise` noun tagging with
>   citation tracking), and the universal anti-slop baseline.
> - **`src/utils/auditEngine.js`** — the audit engine: word-boundary term
>   matching, `fuse.js` fact retrieval with numeric contradiction detection,
>   superlative/absolute claim gating, ALL-CAPS tone checks, canvas
>   dominant-colour mining and palette deviation, WCAG 2.1 luminance/contrast
>   math, and the OCR path.
> - **`src/App.jsx`** — the entire five-tab workspace: guideline compiler UI, ad
>   auditor with surgical fixes and the word-level diff, the role-gated approval
>   workflow with comments and revision history, the drift analytics, the
>   ambiguity auto-refiner, and the Tab 5 signer/seal UI with its canvas-drawn
>   A4 certificate and inline JPEG-to-PDF writer.
> - **Verification & delivery** — production build, lint review, browser smoke
>   tests of every tab's happy path, and this README.
>
> **Tooling disclosure:** as stated in §2.4, I used the **FreeBuff CLI**
> (Codebuff agent, build mode) as a development-time coding assistant for code
> edits, build/lint verification, and documentation drafting. It is not a
> dependency, is not bundled, and makes no runtime calls on behalf of the app.
> All third-party libraries are used under their respective open-source licences,
> disclosed in §2.1.
>
> Signed: **Satyam** — Team Kaizen — Round 2, November 2026.

---

## 6. Known limitations & honest disclosures

These are stated up front so reviewers can calibrate what they are looking at.

1. **OCR cannot see near-1:1 text, so the tile pass is a coarse net.** Word boxes
   and `VIS-WCAG-*` findings now populate on `tesseract.js` 7 (`{ blocks: true }`,
   §2.2), but text whose contrast approaches 1:1 is invisible to OCR — the
   evidence never reaches the word pass. When OCR resolves fewer than two words
   (or its best word sits under 1.6:1) a 16-column tile scan runs and emits **one
   aggregated** `VIS-WCAG-TILE-1` warning, and only when the word pass found
   nothing of its own. It cannot attribute that warning to a specific word, and
   the SVG overlay draws nothing for regions OCR never read. Note that
   `tesseract.js` is more tolerant than expected: banners I generated at 1.04:1
   still produced word boxes, so in practice the word pass (which reports exact
   boxes) fires before the tile net is needed.
2. **Contrast comes from extreme pixels, not glyph segmentation.** For each word
   box the darkest pixel is taken as foreground and the lightest as background.
   That removed the old false 1:1 failures on black-on-white copy, but
   anti-aliasing, outlines and gradients can still bias the ratio either way.
3. **ΔE is CIE76, not CIEDE2000.** The palette check computes real CIELAB D65
   distance and fires above ΔE 28, but CIE76 omits the hue/chroma weighting of
   CIEDE2000, so closely related greens and blues can score slightly away from a
   colourist's judgement.
4. **No persistence.** Reload resets the vault, overrides, comments, and history;
   "Clear for Random Judge Input" clears draft text but leaves the compiled vault
   in place until you re-compile.
5. **Positional issue ids.** Ids are assigned by encounter order, so overrides
   recorded before a re-parse may no longer point at the same rule.
6. **The parser is heuristic.** Unusual phrasing in a real brand book (tables,
   footnotes, multi-column layouts) can produce noisy or missed rules; the
   guideline text is always shown so a human can correct it in the UI.
7. **Override justifications use `window.prompt()`**, which is blocking and
   unstyleable — acceptable for a demo, not for production.
8. **No authentication or server.** Roles are a UI-level switch by design, so the
   governance model can be demonstrated without an account system; there is no
   tamper-proof audit log across users.
