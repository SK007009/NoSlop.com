
# NoSlop.com — Multimodal On-Device Brand Governance & Compliance Engine

**Live Working Product:** https://no-slop-com.vercel.app/  
**Source Code Repository:** https://github.com/SK007009/NoSlop.com
**Hackathon Track:** Round 3 Final Product Submission  

---

##  Executive Summary
**NoSlop.com** is a 100% client-side, zero-backend multimodal brand governance and pre-flight advertisement compliance platform. Built for marketing creators, brand managers, and legal compliance teams, it ingests unstructured brand guidelines (PDFs, images, or prose) and audits promotional ad copy and visual banners entirely inside the browser via **WebAssembly (WASM)** and **ONNX Runtime Web** (`@huggingface/transformers`). 

Zero corporate brand assets, unreleased ad creatives, or proprietary metrics ever leave the user's device, verified by a cryptographic **SHA-256 Zero-Data-Exfiltration Receipt**.

---

##  Quick Start — Clone & Run Locally

Anyone can clone and run this repository locally in under 60 seconds. No external API keys, `.env` secrets, or backend databases are required.

### Prerequisites
* **Node.js:** v18.0.0 or higher (`node -v`)
* **npm:** v9.0.0 or higher (`npm -v`)
* **Browser:** Any modern Chromium, Firefox, or WebKit browser with WebAssembly enabled.

### Installation & Execution

# 1. Clone the repository
git clone https://github.com/SK007009/NoSlop.com
cd noslop

# 2. Install dependencies
npm install

# 3. Start the local Vite development server
npm run dev
Open http://localhost:5173 in your browser.

Note on First-Run Local AI Caching: On your very first audit, the browser will download ~250 MB of quantized ONNX neural network weights (Xenova/clip-vit-base-patch32, Xenova/all-MiniLM-L6-v2, and Xenova/flan-t5-small) directly into your browser's IndexedDB cache. Subsequent runs load instantaneously (0 MB network overhead).

Production Build

npm run build
npm run preview

 Judge's Self-Guided Walkthrough (Main User Journeys)
1. Role-Based Demo Authentication Gate
When clicking "Get Started" or "Launch Workspace", you are greeted by a Google-style Saved Accounts Switcher that locks your active session role across the workspace:

 Demo Creator (creator@noslop.com): Can ingest rules, run audits, apply 1-click surgical fixes, and request exception overrides, but cannot self-approve overrides in Tab 3.

 Demo Manager (manager@noslop.com): Full access to Tab 3 (Role-Based Sign-Off) to approve or reject Creator override requests and unlock publication.

 Demo Advocate (legal@noslop.com): Legal/Compliance reviewer access for regulatory sign-offs.

(Testing Closed-Access Validation): Attempting to sign in via the "Or login as new user" email/password form intentionally triggers the enterprise gate error: "Account not registered for closed testing, contact admin."

Use the "Sign Out" button in the top-right workspace header at any time to switch between Creator and Manager roles.

2. Tab 1: Ingest Guidelines (Dynamic Vault Compilation)
Option A (1-Click Benchmark): Select a pre-loaded real-world brand benchmark from the top bar or upload any custom PDF/Image/TXT brand guideline document.

Option B (Custom Upload): Upload a PDF or image guideline sheet. The engine extracts:

Brand Hex Palette via HTML5 Canvas pixel clustering and CIELAB Delta-E math.

Human-in-the-Loop (HITL) Logo Candidates: Scans the document for high-contrast brand marks. Click a thumbnail to set the primary logo, click "Upload Logo Manually (Fallback)", or skip if text-only.

Banned Terminology & Anti-Slop Rules mapped to approved surgical replacements.

Verified Numeric Facts & Metrics Ledger encoded into 384-d vector embeddings.

Click "Clear" after compiling if you wish to reset the vault and ingest a different brand.

3. Tab 2: Pre-Flight Ad Auditor (Mutually Exclusive Text or Image Audit)
Input Hygiene Lock: To prevent cross-modal state contamination, Tab 2 enforces mutually exclusive inputs—either type/paste Advertisement Copy OR upload an Ad Banner (PNG/JPG), then click "Run Pre-Flight Brand Governance Audit". Once audited, inputs lock until you click "Clear Audit & Start Over".

Remediation Actions:

1-Click Surgical Fix: Directly replaces flagged terminology, unsupported superlatives, or contradictory numeric metrics in your text draft.

1-Click Append Legal Disclaimer: Appends formatted mandatory regulatory footnotes (Disclaimer- ...) for FTC/EPA/FDA/FinTech triggers found in editable copy.

Edit in Canva: Triggered automatically when a violation lives inside flat raster banner artwork (e.g., low WCAG contrast, off-brand visual scene, or baked-in image OCR text).

Request Exception Override: Moves a flag into review with a justification note for the Brand Manager.

4. Tab 3–5: Sign-Off Gate, Drift Analytics & Cryptographic Receipt
Tab 3 (Review & Approval): Log in as Demo Manager to click Approve Exception or Reject (Needs Fix) on pending Creator overrides and view the immutable revision log.

Tab 4 (Drift Analytics): Tracks recurring violation categories and auto-refines ambiguous rules.

Tab 5 (Confidentiality Receipt): Generates a live Web Crypto API SHA-256 hash of the session proving zero cloud data exfiltration.

 Complete List of Working Features
Role-Based Demo Authentication Gate with pre-configured Creator, Brand Manager, and Legal/Compliance sessions

On-Device PDF, Image, and Text Brand Guideline Ingestion Engine (PDF.js + Tesseract.js OCR)

Automated Brand Hex Color Palette Extractor via HTML5 Canvas pixel sampling and CIELAB Delta-E clustering

Human-in-the-Loop (HITL) Logo Candidate Selector with color-agnostic contrast scanning and manual upload fallback

Dynamic Banned Terminology & Universal Anti-Slop Compiler with 1-to-1 surgical replacement mapping

Verified Numeric Facts & Metrics Ledger Extractor from unstructured brand documents and campaign decks

Mutually Exclusive Pre-Flight Ad Auditor supporting Promotional Copy Text or Ad Banner Artwork (PNG/JPG/WEBP)

Zero-Shot Multimodal Visual Scene & Domain Verification using on-device CLIP (Xenova/clip-vit-base-patch32)

Dynamic Contextual Competitor Foil Detection preventing cross-brand identity contamination

Automated WCAG 2.1 AA Contrast Ratio Auditor with spatial tile scanning and OCR bounding-box overlays

On-Device LLM Context-Aware Claim Rewriter and OCR Spell-Repair (Xenova/flan-t5-small via WebAssembly)

Semantic Vector Embedding Engine (Xenova/all-MiniLM-L6-v2) using 384-d cosine similarity for paraphrased claim verification

Trigger-Based Regulatory & Legal Fine-Print Verifier (FTC Green Guides, EPA Range, FinTech APR, QSR weights, Promotional Offers)

Context-Aware Remediation Actions (1-Click Surgical Text Diffs, 1-Click Legal Disclaimer Appending, and Edit in Canva routing for baked-in artwork violations)

Interactive Role-Based Exception Override & Sign-Off Gate with itemized Manager Approve/Reject controls and immutable audit history

Drift Analytics & Auto-Refiner Dashboard for tracking recurring campaign compliance violations

Cryptographic Confidentiality & Zero-Data-Exfiltration Receipt generated via browser Web Crypto API (SHA-256)

 The Three Improvements Delivered Since Round 2
Improvement 1: Local LLM Context-Aware Rewriter & OCR Repair (Xenova/flan-t5-small)
Committed at Round 2: Replace static NLP suggestions (which suffered from an "echo bug" repeating unverified superlatives) with an on-device LLM capable of generating compliant claim rewrites and repairing clipped OCR text.

Delivered: Integrated Xenova/flan-t5-small via WebAssembly in src/utils/localAiEngine.js, paired with 24px white canvas margin padding and pre-LLM regex normalization so edge characters (like the 'V' in 'SUV') and OCR spacing typos are cleanly repaired. To eliminate small-model repetition collapse discovered during stress testing, we paired deterministic surgical replacements directly inside the Suggested Fix pipeline for instant 1-click application.

Improvement 2: Semantic Vector Embeddings for Paraphrased Claims (Xenova/all-MiniLM-L6-v2)
Committed at Round 2: Upgrade fact verification from brittle keyword matching to true Semantic Vector Embeddings so paraphrased false claims are caught even with zero exact keyword overlap.

Delivered: Integrated the 384-dimensional sentence-transformer Xenova/all-MiniLM-L6-v2 in src/utils/localAiEngine.js and src/utils/auditEngine.js. Brand Vault facts are embedded on compilation and compared via cosine similarity against draft claims in real time—catching semantic contradictions (e.g., claiming "runs for 900 miles" vs guideline "330 miles range", or "90,000 restaurants" vs "40,000+ restaurants") and surgically replacing only the divergent metric.

Improvement 3: Trigger-Based Legal Disclaimer & Regulatory Fine-Print Verifier
Committed at Round 2: Build a regulatory trigger scanner for both ad captions and banner OCR covering environmental/greenwashing, EV range, financial APR, and QSR food weight claims, with 1-click remediation.

Delivered: Implemented decoupled regulatory scanners in src/utils/auditEngine.js covering FTC Green Guides (16 CFR 260), EPA mileage disclosures, FinTech APR terms, QSR pre-cooked weight standards, and promotional trial terms. The verifier is strictly context-aware: triggers found in text (source: 'copy') unlock a 1-Click Append Legal Disclaimer button, while triggers baked into flat image artwork (source: 'image') route to Edit in Canva.

Additional Post-Round 2 Enhancements Shipped
Zero-Shot CLIP Vision Scene Matching (Xenova/clip-vit-base-patch32) with dynamic mutually exclusive industry foils.

RBAC Demo Login Gate locking Creator, Brand Manager, and Legal sessions.

Human-in-the-Loop (HITL) Logo Candidate Selector with manual upload fallback.

Itemized Tab 3 Manager Approve/Reject Queue dynamically recalculating the Pre-Publication Trust Score.

Strict Input Hygiene Locks & Dynamic React DOM File Keys eliminating state contamination across back-to-back uploads.

 Technical Architecture & Hardest Problem Solved

┌─────────────────────────────────────────────────────────────────────────┐
│                    Browser Sandbox (100% Client-Side)                   │
├──────────────────────┬─────────────────────────┬────────────────────────┤
│  guidelineParser.js  │    localAiEngine.js     │     auditEngine.js     │
│  • PDF.js (3x Scale) │  • CLIP-ViT-B/32 (WASM) │  • CIELAB Delta-E Math │
│  • Canvas Clustering │  • MiniLM-L6-v2 (384-d) │  • WCAG 2.1 Luminance  │
│  • HITL Logo Scanner │  • FLAN-T5-Small (Seq)  │  • Cosine Similarity   │
│  • Tesseract.js OCR  │  • IndexedDB Weight Cache│  • FTC/EPA/FDA Regex   │
└──────────┬───────────┴────────────┬────────────┴───────────┬────────────┘
           └────────────────────────┼────────────────────────┘
                                    ▼
         React Workspace State (Tab 1–5) + Web Crypto SHA-256 Receipt
Hardest Problem Solved: Running three neural networks (Vision, Embeddings, Seq2Seq LLM) plus OCR concurrently in a single browser tab without crashing memory or suffering from small-model hallucinations. Early experiments with generative image captioners (ViT-GPT2) hallucinated on stylized posters (calling HP printers "white refrigerators"), while static CLIP competitor foils caused false positives on horizontal printer vents. We solved this by standardizing on deterministic zero-shot CLIP (Xenova/clip-vit-base-patch32) with dynamic industry-aware foils, merging adjacent Tesseract word bounding boxes, and routing text replacements through surgical diffs.

 Testing Details & Known Imperfections
What We Tested & Fixed
Cross-Brand State Contamination: Tested back-to-back uploads across 7 brand ecosystems (Nike, Starbucks, Tesla, Adani, HP, McDonald's, Spotify). Fixed residual state bugs by wiping downstream audit states on new vault compilation and binding dynamic Date.now() React keys to hidden <input type="file"> elements.

Regulatory Trigger Precision: Decoupled generic promotional words ("free", "guaranteed") from QSR food-weight and FinTech APR regexes so music/tech ads receive accurate promotional subscription disclaimers rather than food or credit footnotes.

Empty-State Protection: Disabled compilation on empty inputs and removed hardcoded fallback hex palettes (#0090D0).

Known Imperfections (Transparent Limitations)
Stylized Typography in Traditional OCR: While 3.0x canvas upscaling and 24px margin padding resolve most edge-clipping, Tesseract.js can still misread heavily stylized script fonts or low-contrast text over complex photographic backgrounds compared to cloud Vision-Language Models.

Embedded Watermark Isolation: Heuristic canvas contrast scanning isolates logos on clean pages but struggles when a white watermark is overlaid onto busy clouds or lifestyle photography. Mitigated via the HITL candidate gallery and manual logo upload button.

Initial WASM Cold-Start: First-time execution downloads ~250 MB of ONNX weights (10–20s depending on connection) before browser IndexedDB caching makes subsequent runs instant.

Product Roadmap & Future Development Plan
Phase 1 (Months 1–2) — WebGPU Vision-Language OCR (Florence-2 / SmolVLM): Upgrade @huggingface/transformers to v3 (WebGPU) to replace Tesseract.js with unified multimodal vision-language bounding boxes and zero-shot watermark detection.

Phase 2 (Months 3–4) — Native Canva App & Figma Plugin: Port auditEngine.js into the Canva Apps SDK and Figma Plugin API to inspect live vector text layers and apply 1-click surgical fixes inside the designer's canvas before raster export.

Phase 3 (Months 5–6) — Short-Form Video (Reels/TikTok) Compliance: Add client-side Xenova/whisper-tiny audio transcription and 1-fps WebCodecs frame sampling to audit spoken influencer claims and on-screen disclaimer duration.

Phase 4 (Months 6+) — Hybrid E2E-Encrypted Enterprise Sync: Add an optional zero-knowledge Supabase sync layer for compiled brandVault JSON rulesets and Tab 3 Manager sign-off ledgers across global agency teams while keeping media inference 100% on-device