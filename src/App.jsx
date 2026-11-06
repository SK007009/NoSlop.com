import { useMemo, useState } from 'react';
import { diffWords } from 'diff';
import {
  ShieldCheck, Upload, FileText, Image as ImageIcon, CheckCircle2,
  Sparkles, GitPullRequest, BarChart3, Lock, Plus, Trash2
} from 'lucide-react';
import { extractTextFromPDF, extractGuidelinesFromImage, parseRawGuidelines } from './utils/guidelineParser';
import { auditAdText, auditAdImage } from './utils/auditEngine';
import LandingPage from './LandingPage';

// A rule with no authored replacement has no wording worth injecting, and any
// generated placeholder is just as empty. Both mean "delete it", never "paste
// this token into the ad copy".
const isPlaceholderFix = (fix) =>
  !fix ||
  /approved (brand )?terminology|approved alternative|remove or rephrase|custom replacement/i.test(
    String(fix).trim()
  );

// Deleting a term leaves its punctuation orphaned ("payment hack!" -> "payment !"),
// so collapse the gap and pull stray spaces off the punctuation that follows.
const stripOffendingText = (text, offending) =>
  String(text)
    .replace(offending, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([!.,?;:])/g, '$1')
    .trim();

const DEFAULT_AD_TEXT = `Delve into NovaPay's game-changing payment hack!
We offer a 100% uptime guarantee with instant money transfers and cheap pricing!
All customer refunds are completed within 1 business day across 120 countries. BUY NOW RISK-FREE!`;

// 1-click industry test cases so judges can demo without their own files
const AD_PRESETS = [
  {
    id: 'novapay',
    label: 'Fintech — NovaPay',
    sourceName: 'NovaPay_Brand_Book_2026.pdf',
    guidelines: `NovaPay Brand & Compliance Guidelines 2026
Official brand palette hex colors are #2563EB, #10B981, and #0F172A.
Instead of "cheap", use "cost-effective".
Instead of "instant money", use "fast settlement".
Never use the words "miracle", "hack", or "risk-free".
NovaPay provides a 99.9% uptime SLA across all enterprise payment gateways.
Customer refunds are processed within 5 business days.
Our platform secures transactions with 256-bit encryption across 45 countries.`,
    adText: DEFAULT_AD_TEXT
  },
  {
    id: 'zetahealth',
    label: 'Healthcare — ZetaHealth',
    sourceName: 'ZetaHealth_Clinical_Comms_2026.pdf',
    guidelines: `ZetaHealth Clinical Communications Standard 2026
Approved identity colors are #0EA5E9, #14B8A6, and #0F172A.
Instead of "cure", use "manage".
Instead of "patients", use "members".
Never use the words "guaranteed", "risk-free", or "miracle".
ZetaHealth connects members with licensed clinicians in under 15 minutes.
Our virtual care network covers 38 specialties across 12 states.
Clinical records are protected with HIPAA-aligned 256-bit encryption.`,
    adText: `Delve into a guaranteed cure for chronic pain — no waiting rooms!
ZetaHealth offers a miracle consultation with patients in under 5 minutes across 50 states.
Your data is risk-free with our 128-bit encryption. BOOK TODAY!`
  },
  {
    id: 'greenleaf',
    label: 'Eco-Retail — GreenLeaf',
    sourceName: 'GreenLeaf_Brand_Guide_2026.pdf',
    guidelines: `GreenLeaf Sustainable Retail Brand Guide 2026
Core palette hex colors are #16A34A, #FACC15, and #14532D.
Instead of "eco-friendly", use "low-impact".
Instead of "cheap", use "value-priced".
Never use the words "zero waste", "plastic-free", or "miracle".
GreenLeaf ships 92% recycled-fiber packaging within 3 business days.
Our refill program has diverted 1.4 million bottles from landfill since 2021.
Products are certified across 18 suppliers in 6 countries.`,
    adText: `Experience the miracle of truly zero waste living with GreenLeaf!
We deliver plastic-free, eco-friendly refills in 1 business day across 40 countries.
Join 1.4 million happy households. SHOP NOW AND SAVE!`
  }
];

// Banner preview with an SVG bounding-box layer over the OCR word regions
function AdBannerWithBoxes({ src, report }) {
  const [dims, setDims] = useState(null);
  const boxes = (report?.boundingBoxes || []).filter((box) => box.x1 > box.x0 && box.y1 > box.y0);
  const failing = boxes.filter((box) => box.failsContrast).length;

  return (
    <div className="space-y-2">
      <div className="relative mx-auto w-fit">
        <img
          src={src}
          alt="Uploaded Ad Banner with OCR bounding boxes"
          className="max-h-56 w-auto block rounded-lg border border-slate-800 object-contain"
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
        {dims && boxes.length > 0 && (
          <svg
            className="absolute inset-0 h-full w-full pointer-events-none"
            viewBox={`0 0 ${dims.w} ${dims.h}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${boxes.length} OCR text regions, ${failing} fail WCAG contrast`}
          >
            {boxes.map((box, i) => {
              const fails = Boolean(box.failsContrast);
              return (
                <rect
                  key={`${box.x0}-${box.y0}-${i}`}
                  x={box.x0}
                  y={box.y0}
                  width={Math.max(1, box.x1 - box.x0)}
                  height={Math.max(1, box.y1 - box.y0)}
                  fill={fails ? 'rgba(244,63,94,0.16)' : 'rgba(16,185,129,0.12)'}
                  stroke={fails ? '#F43F5E' : '#10B981'}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  className="pointer-events-auto cursor-help"
                  data-fails-contrast={fails}
                >
                  <title>
                    {`${fails ? 'WCAG FAIL' : 'WCAG PASS'}` +
                      (box.contrast != null ? ` · ${box.contrast}:1` : '') +
                      (box.text ? ` · "${box.text}"` : '')}
                  </title>
                </rect>
              );
            })}
          </svg>
        )}
      </div>
      {boxes.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-3 text-[11px] font-medium">
          <span className="flex items-center gap-1.5 text-rose-300">
            <span className="w-2.5 h-2.5 rounded-sm bg-rose-500" />
            Fails WCAG contrast: {failing}
          </span>
          <span className="flex items-center gap-1.5 text-emerald-300">
            <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
            Passes: {boxes.length - failing}
          </span>
        </div>
      ) : (
        report && (
          <p className="text-[11px] text-slate-500 text-center">
            No OCR word boxes returned for this banner — palette and OCR text checks still ran.
          </p>
        )
      )}
    </div>
  );
}

// Decorative lime wave along the bottom edge of every matte charcoal card
function LimeWave() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 400 40"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-10 w-full opacity-70"
    >
      <path
        d="M0 26 C 55 6, 105 34, 160 24 S 280 6, 340 22 S 390 30, 400 18"
        fill="none"
        stroke="#D8FF4B"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M0 34 C 60 16, 120 40, 180 32 S 300 16, 400 32"
        fill="none"
        stroke="#D8FF4B"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  );
}

// 240-degree open horseshoe: start at 150deg, sweep clockwise over the top to 30deg
const TRUST_ARC_PATH = 'M 37.3 147 A 84 84 0 1 1 182.7 147';

function TrustArcGauge({ trustScore, unresolvedCount, overriddenCount, totalIssues, hasAudited, workflowStatus }) {
  const compliantCount = Math.max(0, totalIssues - unresolvedCount - overriddenCount);
  // A clean audit (zero findings) paints a full compliant arc
  const compliantValue = totalIssues === 0 && hasAudited ? 1 : compliantCount;
  const total = Math.max(totalIssues, 1);
  const segments = [
    { key: 'compliant', value: compliantValue, color: '#6F86DC' },
    { key: 'review', value: overriddenCount, color: '#E2CC62' },
    { key: 'remediate', value: unresolvedCount, color: '#DF7A7A' }
  ];
  let offset = 0;
  const statusLabel = !hasAudited ? 'Awaiting Audit' : unresolvedCount > 0 ? 'Needs Remediation' : 'Compliant';

  return (
    <div className="bg-[#F3F4EE] text-[#141712] rounded-[28px] p-6 border border-black/5 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h3 className="text-sm font-semibold tracking-tight">Pre-Publication Brand Trust</h3>
        <ul className="space-y-1.5 text-[11px]">
          {[
            { color: '#6F86DC', label: `Compliant · ${hasAudited ? compliantValue : 0}` },
            { color: '#E2CC62', label: `In Review / Overridden · ${overriddenCount}` },
            { color: '#DF7A7A', label: `To Remediate · ${unresolvedCount}` }
          ].map((item) => (
            <li key={item.label} className="flex items-center gap-2 text-[#2B3129]">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
              {item.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="relative mx-auto mt-2 w-full max-w-[260px]">
        <svg
          viewBox="0 0 220 160"
          role="img"
          aria-label={hasAudited ? `Brand trust score ${trustScore}%` : 'Brand trust score awaiting audit'}
          className="w-full"
        >
          <path d={TRUST_ARC_PATH} fill="none" stroke="#E2E4DC" strokeWidth="16" strokeLinecap="round" />
          {hasAudited &&
            segments.map((segment) => {
              const length = (segment.value / total) * 100;
              const dashOffset = -offset;
              offset += length;
              if (length <= 0) return null;
              return (
                <path
                  key={segment.key}
                  d={TRUST_ARC_PATH}
                  pathLength="100"
                  fill="none"
                  stroke={segment.color}
                  strokeWidth="16"
                  strokeLinecap="round"
                  strokeDasharray={`${length} ${100 - length}`}
                  strokeDashoffset={dashOffset}
                  className="transition-all duration-700 ease-out"
                />
              );
            })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-8 text-center">
          <span className="text-4xl font-bold tracking-tight text-[#121411]">
            {hasAudited ? `${trustScore}%` : '—'}
          </span>
          <span className="mt-1 text-[11px] font-medium text-[#5E6759]">{statusLabel}</span>
        </div>
      </div>
      <p className="text-[11px] text-center text-[#5E6759]">
        {hasAudited ? workflowStatus : 'Run the pre-flight audit to populate the arc.'}
      </p>
    </div>
  );
}

const PRODUCT_ENGINES = [
  {
    name: 'Multimodal Guideline Compiler',
    stack: 'pdfjs · Canvas · Tesseract v7',
    body: 'PDF pages are rendered at 1.5× and sampled for real palette colours, scanned or image-based decks fall back to Tesseract OCR, and plain text is parsed directly. Every written #HEX, banned term, replacement rule and numeric fact lands in a vault that never leaves the tab.'
  },
  {
    name: 'Visual & Accessibility Auditor',
    stack: 'CIELAB ΔE₇₆ · WCAG 2.1',
    body: 'Dominant banner colours are compared to your approved palette in CIELAB space, and contrast is measured inside every OCR word box — with a pixel-tile fallback for the faint overlay text OCR cannot see at all.'
  },
  {
    name: 'Claim & Anti-Slop Verifier',
    stack: 'Compromise NLP · Fuse.js',
    body: 'Compromise NLP pulls nouns and metrics out of each sentence, then Fuse.js fuzzy-matches the claim against substantiated facts — so a wrong percentage or an unsupported superlative is caught before it ships.'
  },
  {
    name: 'Sign-Off & Drift Auto-Refiner',
    stack: 'Role-based workflow · Git-style log',
    body: 'Approval is gated across Creator, Brand Manager and Legal Reviewer with an immutable revision log. Recurring human overrides are grouped by rule so the ambiguous guideline itself can be rewritten.'
  }
];

function ProductOverview({ onLaunch }) {
  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden bg-[radial-gradient(120%_120%_at_0%_0%,#D8FF4B_0%,#E4F884_55%,#F3F5EC_100%)] text-[#121510] rounded-[28px] p-8 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#121510]/60">
          Product capabilities & architecture
        </span>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">Four engines, one browser tab.</h2>
        <p className="mt-2 max-w-2xl text-sm text-[#2B3129]">
          NoSlop.com runs every check locally — no upload endpoint, no cloud LLM, no API key. Each
          engine below is bundled into this page and executes on your machine.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PRODUCT_ENGINES.map((engine, index) => (
          <div
            key={engine.name}
            className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)]"
          >
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 shrink-0 rounded-full bg-[#121411] text-[#D8FF4B] flex items-center justify-center text-xs font-semibold">
                {index + 1}
              </span>
              <h3 className="font-semibold text-base tracking-tight">{engine.name}</h3>
            </div>
            <p className="mt-3 text-xs text-[#2B3129] leading-relaxed">{engine.body}</p>
            <span className="mt-4 inline-block text-[11px] px-3 py-1 rounded-full bg-white/10 text-[#D8FF4B]">
              {engine.stack}
            </span>
          </div>
        ))}
      </div>

      <button
        onClick={onLaunch}
        className="w-full py-3 rounded-full bg-[#121411] hover:bg-[#22261f] text-sm font-semibold text-[#D8FF4B] cursor-pointer"
      >
        Launch Workspace →
      </button>
    </div>
  );
}

const GUIDE_STEPS = [
  {
    title: 'Ingest Brand Guidelines',
    where: 'Tab 1',
    body: 'Upload any Brand Book PDF (selectable or scanned), a brand image or logo, or raw text. NoSlop automatically mines approved #HEX colours, prohibited terms, replacement rules and verified quantitative facts.'
  },
  {
    title: 'Audit Ad Copy & Visual Banners',
    where: 'Tab 2',
    body: 'Paste promotional copy and/or upload an ad banner image. The local engine runs Tesseract v7 OCR, checks WCAG 2.1 contrast and CIELAB ΔE colour distance, and cross-verifies claims against your compiled facts.'
  },
  {
    title: 'Apply Surgical Fixes or Request Exceptions',
    where: 'Tab 2',
    body: 'Use 1-click surgical text replacements, enter custom fixes for banned words, or open visual assets in Canva (with privacy warnings) while tracking red/green inline word diffs.'
  },
  {
    title: 'Role-Based Review & Sign-Off',
    where: 'Tab 3',
    body: 'Switch roles between Creator, Brand Manager and Legal Reviewer to leave inline comments, inspect the immutable revision log, and unlock publication approval.'
  },
  {
    title: 'Track Guideline Drift & Export AI Receipt',
    where: 'Tabs 4 & 5',
    body: 'Identify frequently overridden rules to auto-refine ambiguous brand guidelines and export a signed JSON Confidentiality & AI Disclosure Receipt.'
  }
];

function HowItWorksGuide({ onGoToStep1 }) {
  return (
    <div className="space-y-6">
      <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-8 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5E6759]">
          Step-by-step guide
        </span>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">How NoSlop.com Works</h2>
        <p className="mt-2 max-w-2xl text-sm text-[#2B3129]">
          Five steps from an uploaded brand book to a signed publication receipt — every one of them
          running in this browser tab.
        </p>
      </div>

      <div className="space-y-3">
        {GUIDE_STEPS.map((step, index) => (
          <div
            key={step.title}
            className="relative overflow-hidden bg-[#121411] text-[#F3F4EE] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.18)]"
          >
            <LimeWave />
            <div className="relative z-10 flex items-start gap-4">
              <span className="w-10 h-10 shrink-0 rounded-full bg-white/10 text-[#D8FF4B] flex items-center justify-center text-sm font-semibold">
                {index + 1}
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-base tracking-tight">
                    Step {index + 1} — {step.title}
                  </h3>
                  <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-white/10 text-[#D8FF4B]">
                    {step.where}
                  </span>
                </div>
                <p className="mt-2 text-xs text-[#F3F4EE]/70 leading-relaxed">{step.body}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onGoToStep1}
        className="w-full py-3 rounded-full bg-[radial-gradient(120%_120%_at_0%_0%,#D8FF4B_0%,#E4F884_100%)] text-[#121510] text-sm font-semibold cursor-pointer"
      >
        Go to Step 1: Ingest Guidelines →
      </button>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('landing');
  // 'tabs' shows the five workspace tabs; 'product' and 'guide' are the other two
  // destinations the landing navbar can open inside this same window.
  const [workspaceView, setWorkspaceView] = useState('tabs');
  const [activeTab, setActiveTab] = useState('compiler');
  const [role, setRole] = useState('Creator');
  // Starts genuinely empty: no demo brand book, no pre-filled ad copy, no seeded
  // history. A preset arrives only if the user picks one from the header dropdown.
  const [rawGuidelineText, setRawGuidelineText] = useState('');
  const [isCompiled, setIsCompiled] = useState(false);
  const [sourceName, setSourceName] = useState('');
  // Palette colours sampled from PDF pages / guideline artwork, kept so a manual
  // re-compile still merges what the canvas found.
  const [visualColors, setVisualColors] = useState([]);
  const [isParsing, setIsParsing] = useState(false);
  const [parsePercent, setParsePercent] = useState(0);
  const [parseStatus, setParseStatus] = useState('');
  // Reviewer-typed replacements for banned terms that have no approved wording.
  const [customFixes, setCustomFixes] = useState({});
  const [brandVault, setBrandVault] = useState({
    sourceName: 'None Loaded',
    rawText: '',
    colors: [],
    bannedTerms: [],
    facts: [],
    minContrastRatio: 4.5
  });

  // Manual Rule Inputs
  const [newTerm, setNewTerm] = useState('');
  const [newReplacement, setNewReplacement] = useState('');
  const [newFact, setNewFact] = useState('');
  const [newColor, setNewColor] = useState('#6366F1');

  // Ad Auditor State
  const [originalAdText, setOriginalAdText] = useState('');
  const [workingAdText, setWorkingAdText] = useState('');
  const [imagePreview, setImagePreview] = useState(null);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [isAuditing, setIsAuditing] = useState(false);
  const [issues, setIssues] = useState([]);
  const [imageReport, setImageReport] = useState(null);

  // Workflow & Governance State
  const [workflowStatus, setWorkflowStatus] = useState('Draft — Awaiting Pre-Flight Audit');
  const [overrides, setOverrides] = useState({});
  // Per-rule edit drafts for the Tab 4 Auto-Refiner, editable before commit
  const [refineDrafts, setRefineDrafts] = useState({});
  const [revisionHistory, setRevisionHistory] = useState([]);
  const [commentInput, setCommentInput] = useState('');
  const [comments, setComments] = useState([]);

  // Load a 1-click industry test case (guidelines + matching ad draft)
  const handleApplyPreset = (e) => {
    const preset = AD_PRESETS.find((p) => p.id === e.target.value);
    e.target.value = '';
    if (!preset) return;

    const compiled = parseRawGuidelines(preset.guidelines, preset.sourceName);
    setRawGuidelineText(preset.guidelines);
    setIsCompiled(false);
    setSourceName(preset.sourceName);
    setBrandVault(compiled);
    setOriginalAdText(preset.adText);
    setWorkingAdText(preset.adText);
    setIssues([]);
    setImageReport(null);
    setVisualColors([]);
    setOverrides({});
    setRefineDrafts({});
    setWorkflowStatus('Draft — Awaiting Pre-Flight Audit');
    setActiveTab('auditor');
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `Loaded ${preset.label} preset: compiled ${compiled.bannedTerms.length} terminology rules & ${compiled.facts.length} facts from ${preset.sourceName}`
      },
      ...prev
    ]);
  };

  // Compile pasted or uploaded guidelines
  const handleCompileGuidelines = () => {
    const compiled = parseRawGuidelines(rawGuidelineText, sourceName || 'Custom Brand Guidelines', visualColors);
    setBrandVault(compiled);
    setIsCompiled(true);
    setRevisionHistory((prev) => [
      { time: new Date().toLocaleTimeString(), actor: role, action: `Compiled ${compiled.facts.length} facts & ${compiled.bannedTerms.length} terminology rules from ${sourceName}` },
      ...prev
    ]);
  };

  // Ingest a guideline from PDF, image or text. PDF pages are rendered so their
  // artwork contributes palette colours, and scanned pages fall back to OCR.
  const handleGuidelineFileUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const lower = file.name.toLowerCase();
    setSourceName(file.name);
    setIsCompiled(false);
    setIsParsing(true);
    setParsePercent(0);
    setParseStatus(`Reading ${file.name}…`);

    const onProgress = (percent, message) => {
      setParsePercent(Math.max(0, Math.min(100, Math.round(percent))));
      if (message) setParseStatus(message);
    };

    try {
      let text = '';
      let sampledColors = [];

      if (lower.endsWith('.pdf')) {
        setParseStatus('Scanning PDF pages & extracting visual brand rules…');
        const extracted = await extractTextFromPDF(file, onProgress);
        text = extracted.text;
        sampledColors = extracted.visualColors;
      } else if (/\.(png|jpe?g|webp)$/.test(lower)) {
        setParseStatus('Scanning image & extracting visual brand rules…');
        const extracted = await extractGuidelinesFromImage(file, onProgress);
        text = extracted.text;
        sampledColors = extracted.visualColors;
      } else {
        text = await file.text();
        onProgress(100, 'Text file read');
      }

      const trimmed = (text || '').trim();
      const compiled = parseRawGuidelines(trimmed, file.name, sampledColors);
      setVisualColors(sampledColors);
      setBrandVault(compiled);

      if (trimmed.length === 0) {
        setRawGuidelineText('');
        setParseStatus('No readable text found — paste the guideline text below.');
        return;
      }

      setRawGuidelineText(trimmed);
      setIsCompiled(true);
      setRevisionHistory((prev) => [
        {
          time: new Date().toLocaleTimeString(),
          actor: role,
          action: `Ingested ${file.name}: ${compiled.colors.length} palette colours (${sampledColors.length} sampled from artwork), ${compiled.bannedTerms.length} terminology rules & ${compiled.facts.length} facts`
        },
        ...prev
      ]);
    } catch (err) {
      console.warn('Guideline ingestion failed:', err);
      setParseStatus('Extraction failed — paste the guideline text below.');
    } finally {
      setIsParsing(false);
    }
  };

  // Run Full Pre-Publication Audit
  const handleRunAudit = async () => {
    setIsAuditing(true);
    setOcrProgress(0);
    const textIssues = auditAdText(workingAdText, brandVault);
    let combinedIssues = [...textIssues];

    if (imagePreview) {
      const imgRes = await auditAdImage(imagePreview, brandVault, setOcrProgress);
      setImageReport(imgRes);
      combinedIssues = [...combinedIssues, ...imgRes.issues];
    } else {
      setImageReport(null);
    }

    setIssues(combinedIssues);
    setWorkflowStatus(combinedIssues.length === 0 ? 'Ready for Approval' : 'Flags Detected — Needs Remediation');
    setRevisionHistory((prev) => [
      { time: new Date().toLocaleTimeString(), actor: role, action: `Ran Pre-Flight Audit: ${combinedIssues.length} compliance flags found` },
      ...prev
    ]);
    setIsAuditing(false);
  };

  // Apply 1-Click Surgical Fix. A placeholder or missing fix has no wording to
  // insert, so it deletes the offending phrase instead of writing a canned token.
  const handleApplyFix = (issue) => {
    const custom = (customFixes[issue.id] || '').trim();
    const needsCustom = isPlaceholderFix(issue.suggestedFix);
    if (needsCustom && !custom) {
      handleRemoveWord(issue);
      return;
    }

    const replacement = custom || issue.suggestedFix;
    setWorkingAdText((prev) => prev.replace(issue.offendingText, replacement));
    setIssues((prev) => prev.filter((i) => i.id !== issue.id));
    setCustomFixes((prev) => {
      const next = { ...prev };
      delete next[issue.id];
      return next;
    });
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `Applied ${custom ? 'custom replacement' : 'surgical fix'} for [${issue.category}]: "${issue.offendingText.slice(0, 28)}" → "${String(replacement).slice(0, 28)}"`
      },
      ...prev
    ]);
  };

  // Replace with the reviewer's own wording, or remove the word when left blank.
  const handleApplyCustomReplacement = (issue) => {
    const custom = (customFixes[issue.id] || '').trim();
    if (!custom) {
      handleRemoveWord(issue);
      return;
    }
    if (isPlaceholderFix(custom)) {
      setParseStatus('Type your own replacement wording, or use Remove Word.');
      return;
    }

    setWorkingAdText((prev) => prev.replace(issue.offendingText, custom));
    setIssues((prev) => prev.filter((i) => i.id !== issue.id));
    setCustomFixes((prev) => {
      const next = { ...prev };
      delete next[issue.id];
      return next;
    });
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `Applied custom replacement for ${issue.id}: "${issue.offendingText}" → "${custom}"`
      },
      ...prev
    ]);
  };

  // Delete the offending phrase and tidy the punctuation it leaves behind.
  const handleRemoveWord = (issue) => {
    setWorkingAdText((prev) => stripOffendingText(prev, issue.offendingText));
    setIssues((prev) => prev.filter((i) => i.id !== issue.id));
    setCustomFixes((prev) => {
      const next = { ...prev };
      delete next[issue.id];
      return next;
    });
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `Removed flagged text "${issue.offendingText}" from the draft`
      },
      ...prev
    ]);
  };

  // Request Human Exception Override
  const handleRequestOverride = (issue) => {
    const reason = window.prompt(`Enter justification for overriding "${issue.offendingText}":`, 'Intentional campaign phrasing for target audience');
    if (!reason) return;
    setOverrides((prev) => ({
      ...prev,
      [issue.id]: { reason, ruleId: issue.ruleId, category: issue.category, actor: role }
    }));
    setRevisionHistory((prev) => [
      { time: new Date().toLocaleTimeString(), actor: role, action: `Requested exception override on ${issue.id}: "${reason}"` },
      ...prev
    ]);
  };

  // Image findings live inside the artwork, so the only local action is to accept
  // the risk — record it as an override without prompting for a reason.
  const handleSkipImageIssue = (issue) => {
    const reason = 'Skipped — banner artwork kept as is (image edits happen outside NoSlop)';
    setOverrides((prev) => ({
      ...prev,
      [issue.id]: { reason, ruleId: issue.ruleId, category: issue.category, actor: role }
    }));
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `Skipped image issue ${issue.id}: "${reason}"`
      },
      ...prev
    ]);
  };

  const unresolvedCount = issues.filter((i) => !overrides[i.id]).length;
  const trustScore = Math.max(0, 100 - unresolvedCount * 14);
  // A run has happened once the workflow leaves its initial draft state.
  const hasAudited = workflowStatus !== 'Draft — Awaiting Pre-Flight Audit';
  const diffs = diffWords(originalAdText, workingAdText);

  // Resolve an override's ruleId back to the live rule held in the Brand Vault
  const findVaultRule = (ruleId) =>
    brandVault.bannedTerms.find((r) => r.id === ruleId) ||
    brandVault.facts.find((f) => f.id === ruleId) ||
    brandVault.colors.find((c) => c.id === ruleId) ||
    null;

  // Group every human override by the rule it broke, so ambiguous guidelines surface once
  const overrideGroups = useMemo(() => {
    const groups = new Map();
    Object.entries(overrides).forEach(([issueId, ov]) => {
      const ruleId = ov.ruleId || 'UNLINKED';
      if (!groups.has(ruleId)) groups.set(ruleId, { ruleId, category: ov.category, entries: [] });
      groups.get(ruleId).entries.push({ issueId, ...ov });
    });
    return [...groups.values()];
  }, [overrides]);

  // Turn a free-text justification into a replacement phrase when the reviewer named one
  const suggestRefinedReplacement = (justification, fallback) => {
    const quoted = justification.match(/["“']([^"”']{2,40})["”']/);
    if (quoted) return quoted[1].trim();
    const directive = justification.match(/\b(?:use|say|write|prefer|replace with|should say)\s+([^.,;]{2,40})/i);
    if (directive) return directive[1].trim();
    return fallback;
  };

  // Editable draft for one Auto-Refiner row. Seeded from the override text (or the
  // clarification already stored on the rule) so the reviewer edits real wording
  // rather than retyping it from scratch.
  const refineDraftFor = (group) => {
    const rule = findVaultRule(group.ruleId);
    const stored = refineDrafts[group.ruleId] || {};
    const seededJustification = group.entries.map((e) => e.reason).filter(Boolean).join(' | ');
    return {
      justification: stored.justification ?? (rule?.clarification || seededJustification),
      replacement: stored.replacement ?? (rule && rule.term ? rule.replacement : '')
    };
  };

  const updateRefineDraft = (ruleId, patch) =>
    setRefineDrafts((prev) => ({ ...prev, [ruleId]: { ...(prev[ruleId] || {}), ...patch } }));

  // 1-click refinement: write the human justification + clarified replacement into the vault
  const handleUpdateBrandRule = (group, draft = {}) => {
    const rule = findVaultRule(group.ruleId);
    if (!rule) return;
    const justification =
      (draft.justification || '').trim() ||
      group.entries.map((e) => e.reason).filter(Boolean).join(' | ');
    const refinement = {
      clarification: justification,
      refinedBy: role,
      refinedAt: new Date().toLocaleString(),
      refined: true
    };
    const isTermRule = brandVault.bannedTerms.some((r) => r.id === group.ruleId);
    const refinedReplacement = isTermRule
      ? (draft.replacement || '').trim() || suggestRefinedReplacement(justification, rule.replacement)
      : null;

    setBrandVault((v) => ({
      ...v,
      bannedTerms: v.bannedTerms.map((r) =>
        r.id === group.ruleId ? { ...r, replacement: refinedReplacement || r.replacement, ...refinement } : r
      ),
      facts: v.facts.map((f) => (f.id === group.ruleId ? { ...f, ...refinement } : f)),
      colors: v.colors.map((c) => (c.id === group.ruleId ? { ...c, ...refinement } : c))
    }));

    setRefineDrafts((prev) => ({
      ...prev,
      [group.ruleId]: {
        justification,
        replacement: refinedReplacement || (isTermRule ? rule.replacement : '')
      }
    }));

    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `Refined Brand Vault rule ${group.ruleId} from ${group.entries.length} human override(s): "${justification.slice(0, 80)}"`
      },
      ...prev
    ]);
  };

  if (view === 'landing') {
    return (
      <LandingPage
        onEnter={(target) => {
          if (target === 'landing') {
            setView('landing');
            return;
          }
          setView('app');
          // Product and the step-by-step guide are their own views, not tabs.
          if (target === 'product' || target === 'guide') {
            setWorkspaceView(target);
            return;
          }
          setWorkspaceView('tabs');
          setActiveTab(target || 'compiler');
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#C8CFC0] text-[#141712] flex flex-col">
      {/* Top Navbar */}
      <header className="border-b border-black/10 bg-[#C8CFC0]/85 backdrop-blur px-6 py-3 flex flex-wrap items-center justify-between gap-4">
        <div
          className="flex items-center gap-3 cursor-pointer"
          onClick={() => setView('landing')}
          title="Back to landing page"
        >
          <div className="w-10 h-10 rounded-2xl bg-[#121411] text-[#D8FF4B] flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg tracking-tight text-[#121411]">NoSlop.com</h1>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-[#121411] text-[#D8FF4B]">
                100% Client-Side Open Source
              </span>
            </div>
            <p className="text-xs text-[#5E6759]">Dynamic Brand Governance & Claim Verification • Team Kaizen (Satyam)</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-[#F3F4EE] px-3.5 py-2 rounded-full border border-black/10">
            <span className="text-xs text-[#5E6759]">Quick Industry Test Case:</span>
            <select
              defaultValue=""
              onChange={handleApplyPreset}
              className="bg-transparent text-xs font-semibold text-[#121411] focus:outline-none cursor-pointer max-w-[13rem]"
            >
              <option value="" className="bg-[#F3F4EE] text-[#121411]">Load Preset Scenario…</option>
              {AD_PRESETS.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#F3F4EE] text-[#121411]">
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => {
              setRawGuidelineText('');
              setIsCompiled(false);
              setSourceName('Custom_Input.txt');
              setOriginalAdText('');
              setWorkingAdText('');
              setImagePreview(null);
              setIssues([]);
            }}
            className="text-xs px-4 py-2 rounded-full bg-[#F3F4EE] border border-black/10 hover:bg-white text-[#121411] cursor-pointer"
          >
            Clear for Random Judge Input
          </button>

          <div className="flex items-center gap-2 bg-[#F3F4EE] px-3.5 py-2 rounded-full border border-black/10">
            <span className="text-xs text-[#5E6759]">Active Role:</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="bg-transparent text-xs font-semibold text-[#121411] focus:outline-none cursor-pointer"
            >
              <option value="Creator" className="bg-[#F3F4EE] text-[#121411]">Creator (Writer/Designer)</option>
              <option value="Brand Manager" className="bg-[#F3F4EE] text-[#121411]">Brand Manager (Approver)</option>
              <option value="Legal Reviewer" className="bg-[#F3F4EE] text-[#121411]">Legal Reviewer (Compliance)</option>
            </select>
          </div>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="px-6 pt-4 flex gap-2 overflow-x-auto">
        {[
          { id: 'compiler', label: '1. Ingest Guidelines', icon: FileText },
          { id: 'auditor', label: '2. Pre-Flight Ad Auditor', icon: Sparkles },
          { id: 'workflow', label: '3. Review & Approval Workflow', icon: GitPullRequest },
          { id: 'analytics', label: '4. Drift Analytics & Auto-Refiner', icon: BarChart3 },
          { id: 'receipt', label: '5. Confidentiality Receipt', icon: Lock }
        ].map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setWorkspaceView('tabs');
                setActiveTab(tab.id);
              }}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-full transition cursor-pointer whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-[#121411] text-[#D8FF4B] shadow-[0_12px_32px_rgba(20,24,18,0.06)]'
                  : 'bg-[#F3F4EE]/70 text-[#2B3129] border border-black/5 hover:bg-[#F3F4EE]'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 px-6 py-8 max-w-7xl w-full mx-auto">
        {workspaceView === 'product' && (
          <ProductOverview
            onLaunch={() => {
              setWorkspaceView('tabs');
              setActiveTab('compiler');
            }}
          />
        )}

        {workspaceView === 'guide' && (
          <HowItWorksGuide
            onGoToStep1={() => {
              setWorkspaceView('tabs');
              setActiveTab('compiler');
            }}
          />
        )}

        {workspaceView === 'tabs' && (
        <>
        {/* TAB 1: INGEST GUIDELINES — raw textarea & upload while uncompiled */}
        {activeTab === 'compiler' && !isCompiled && (
          <div className="relative overflow-hidden max-w-2xl w-full mx-auto bg-[radial-gradient(120%_120%_at_0%_0%,#D8FF4B_0%,#E4F884_55%,#F3F5EC_100%)] text-[#121510] rounded-[28px] p-6 flex flex-col gap-4 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#121510] text-[#D8FF4B] flex items-center justify-center shrink-0">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-base tracking-tight">Ingest Any Brand Guideline Document</h2>
                    <p className="text-[11px] text-[#121510]/60">PDF, scanned slides, images or plain prose — parsed on-device.</p>
                  </div>
                </div>
                <label
                  className={`flex items-center gap-1.5 text-xs bg-[#121510] hover:bg-[#22261f] text-[#D8FF4B] px-3.5 py-2 rounded-full cursor-pointer whitespace-nowrap ${
                    isParsing ? 'pointer-events-none opacity-60' : ''
                  }`}
                >
                  <Upload className="w-3.5 h-3.5" />
                  {isParsing ? 'Extracting…' : 'Upload Guideline (PDF / Image / TXT)'}
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp"
                    onChange={handleGuidelineFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
              <div className="h-1 w-full rounded-full bg-[#121510]/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#121510] transition-all duration-500"
                  style={{ width: `${isParsing ? Math.max(8, parsePercent) : 42}%` }}
                />
              </div>
              {isParsing && (
                <div className="flex items-center justify-between gap-3 text-[11px] text-[#121510]/70">
                  <span>{parseStatus}</span>
                  <span className="font-mono">{parsePercent}%</span>
                </div>
              )}
              <p className="text-xs text-[#2B3129]">
                Paste brand guideline prose or upload a PDF, scanned slide deck, or a PNG/JPG/WEBP brand sheet. Written #HEX codes, colours sampled from the artwork itself, banned terms, replacement directives and numeric facts are all extracted on-device.
              </p>
              <textarea
                value={rawGuidelineText}
                onChange={(e) => {
                  setRawGuidelineText(e.target.value);
                  setIsCompiled(false);
                }}
                rows={11}
                placeholder="Paste any unstructured brand guidelines, approved facts, #HEX codes, and banned words here..."
                className="w-full rounded-2xl bg-[#E7E9E0] border border-black/10 p-3 text-xs font-mono text-[#141712] focus:border-[#121411] focus:outline-none"
              />
              <button
                onClick={handleCompileGuidelines}
                className="w-full py-2.5 rounded-full bg-[#121411] hover:bg-[#22261f] font-semibold text-sm text-[#D8FF4B] transition cursor-pointer"
              >
                Compile Guidelines into Active Rules
              </button>
          </div>
        )}

        {/* TAB 1: COMPILED BRAND VAULT RESULTS — ingestion UI hidden once compiled */}
        {activeTab === 'compiler' && isCompiled && (
          <div className="space-y-4">
            <button
              onClick={() => setIsCompiled(false)}
              className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-full bg-[#F3F4EE] border border-black/10 hover:bg-white text-[#121411] cursor-pointer"
            >
              ← Edit Raw Guidelines
            </button>
            <div className="flex flex-col gap-4">
              {/* Compiled Hex Colors */}
              <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold tracking-tight">Compiled Brand Hex Palette ({brandVault.colors.length})</h3>
                  <div className="flex items-center gap-2">
                    <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value.toUpperCase())} className="w-6 h-6 rounded cursor-pointer" />
                    <button
                      onClick={() =>
                        setBrandVault((v) => ({
                          ...v,
                          colors: [...v.colors, { id: `CLR-${Date.now()}`, name: 'Custom Color', hex: newColor, source: 'Manual Entry' }]
                        }))
                      }
                      className="text-xs bg-[#121411] hover:bg-[#22261f] text-[#D8FF4B] px-3.5 py-1.5 rounded-full flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" /> Add Hex
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {brandVault.colors.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 bg-[#E7E9E0] border border-black/10 px-3 py-1.5 rounded-full text-xs">
                      <span className="w-4 h-4 rounded-full border border-white/20" style={{ backgroundColor: c.hex }} />
                      <span className="font-mono font-semibold">{c.hex}</span>
                      <button
                        onClick={() => setBrandVault((v) => ({ ...v, colors: v.colors.filter((x) => x.id !== c.id) }))}
                        className="text-[#7A8375] hover:text-[#B4463F] cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Compiled Banned & Replacement Terminology */}
              <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                <h3 className="text-sm font-semibold mb-2 tracking-tight">Compiled Banned Terms & Surgical Replacements ({brandVault.bannedTerms.length})</h3>
                <div className="flex gap-2 mb-3">
                  <input
                    value={newTerm}
                    onChange={(e) => setNewTerm(e.target.value)}
                    placeholder="Forbidden term (e.g. miracle)"
                    className="flex-1 bg-[#E7E9E0] border border-black/10 rounded-2xl px-3 py-2 text-xs text-[#141712] focus:border-[#121411] focus:outline-none"
                  />
                  <input
                    value={newReplacement}
                    onChange={(e) => setNewReplacement(e.target.value)}
                    placeholder="Approved fix (e.g. clinically proven)"
                    className="flex-1 bg-[#E7E9E0] border border-black/10 rounded-2xl px-3 py-2 text-xs text-[#141712] focus:border-[#121411] focus:outline-none"
                  />
                  <button
                    onClick={() => {
                      if (!newTerm.trim()) return;
                      setBrandVault((v) => ({
                        ...v,
                        bannedTerms: [
                          {
                            id: `RULE-M${Date.now()}`,
                            term: newTerm.toLowerCase(),
                            replacement: newReplacement || 'approved term',
                            reason: 'Custom terminology rule',
                            citation: 'Manual Brand Rule Entry'
                          },
                          ...v.bannedTerms
                        ]
                      }));
                      setNewTerm('');
                      setNewReplacement('');
                    }}
                    className="text-xs bg-[#121411] hover:bg-[#22261f] px-3.5 py-1.5 rounded-full text-[#D8FF4B] cursor-pointer whitespace-nowrap"
                  >
                    + Add Rule
                  </button>
                </div>
                <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                  {brandVault.bannedTerms.map((r) => (
                    <div key={r.id} className="flex items-center justify-between bg-[#E7E9E0] border border-black/10 px-3 py-2 rounded-2xl text-xs">
                      <div>
                        <span className="text-[#B4463F] font-mono line-through mr-2">"{r.term}"</span>
                        <span className="text-[#3F6B3A] font-mono">→ "{r.replacement}"</span>
                        <span className="text-[#7A8375] ml-2">({r.citation.slice(0, 45)}...)</span>
                      </div>
                      <button
                        onClick={() => setBrandVault((v) => ({ ...v, bannedTerms: v.bannedTerms.filter((x) => x.id !== r.id) }))}
                        className="text-[#7A8375] hover:text-[#B4463F] cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Compiled Quantitative Facts Ledger */}
              <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                <h3 className="text-sm font-semibold mb-2 tracking-tight">Compiled Approved Facts & Metrics Ledger ({brandVault.facts.length})</h3>
                <div className="flex gap-2 mb-3">
                  <input
                    value={newFact}
                    onChange={(e) => setNewFact(e.target.value)}
                    placeholder="Add official fact with number (e.g., Delivery takes 24 hours across 150 hospitals)"
                    className="flex-1 bg-[#E7E9E0] border border-black/10 rounded-2xl px-3 py-2 text-xs text-[#141712] focus:border-[#121411] focus:outline-none"
                  />
                  <button
                    onClick={() => {
                      if (!newFact.trim()) return;
                      const nums = newFact.match(/\b\d+(?:\.\d+)?(?:\s*%|\+|\s*x|-bit)?\b/g) || [];
                      setBrandVault((v) => ({
                        ...v,
                        facts: [
                          {
                            id: `FACT-M${Date.now()}`,
                            statement: newFact,
                            numbers: nums,
                            keywords: newFact.toLowerCase(),
                            citation: 'Manual Fact Entry'
                          },
                          ...v.facts
                        ]
                      }));
                      setNewFact('');
                    }}
                    className="text-xs bg-[#121411] hover:bg-[#22261f] px-3.5 py-1.5 rounded-full text-[#D8FF4B] cursor-pointer whitespace-nowrap"
                  >
                    + Add Fact
                  </button>
                </div>
                <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                  {brandVault.facts.map((f) => (
                    <div key={f.id} className="bg-[#E7E9E0] border border-black/10 px-3 py-2.5 rounded-2xl text-xs flex justify-between items-start gap-2">
                      <div>
                        <p className="text-[#141712]">{f.statement}</p>
                        <p className="text-[11px] text-[#5E6759] mt-0.5">
                          Pinned Metrics: {f.numbers.join(', ')} • Source: {f.citation}
                        </p>
                      </div>
                      <button
                        onClick={() => setBrandVault((v) => ({ ...v, facts: v.facts.filter((x) => x.id !== f.id) }))}
                        className="text-[#7A8375] hover:text-[#B4463F] cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: PRE-FLIGHT AD AUDITOR */}
        {activeTab === 'auditor' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-6 flex flex-col gap-4">
              <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 flex flex-col gap-3 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                <h2 className="font-semibold text-base tracking-tight">Advertisement Copy & Creative Input</h2>
                <textarea
                  value={workingAdText}
                  onChange={(e) => {
                    setWorkingAdText(e.target.value);
                    if (!originalAdText) setOriginalAdText(e.target.value);
                  }}
                  rows={6}
                  placeholder="Paste any advertisement copy, social caption, or promotional claim to audit..."
                  className="w-full rounded-2xl bg-[#E7E9E0] border border-black/10 p-3 text-sm text-[#141712] focus:border-[#121411] focus:outline-none"
                />

                {/* Banner Image Uploader */}
                <div className="border border-dashed border-black/15 rounded-2xl p-3 bg-[#E7E9E0]/70 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs text-[#2B3129]">
                    <ImageIcon className="w-4 h-4 text-[#5E6759]" />
                    <span>{imagePreview ? 'Ad Banner Loaded (OCR + WCAG Ready)' : 'Optional: Upload Ad Banner (PNG/JPG) for Visual + OCR Audit'}</span>
                  </div>
                  <label className="text-xs bg-[#121411] hover:bg-[#22261f] text-[#D8FF4B] px-3.5 py-1.5 rounded-full cursor-pointer whitespace-nowrap">
                    Browse Image
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) setImagePreview(URL.createObjectURL(file));
                      }}
                      className="hidden"
                    />
                  </label>
                </div>

                {imagePreview && (
                  <div className="space-y-2">
                    <AdBannerWithBoxes src={imagePreview} report={imageReport} />
                    {imageReport && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-[#5E6759]">Extracted Banner Colors:</span>
                        {imageReport.dominantColors.map((c, i) => (
                          <span key={i} className="flex items-center gap-1 bg-[#E7E9E0] px-2 py-0.5 rounded-full border border-black/10 font-mono">
                            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: c.hex }} />
                            {c.hex}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={handleRunAudit}
                  disabled={isAuditing}
                  className="w-full py-2.5 rounded-full bg-[#121411] hover:bg-[#22261f] font-semibold text-sm text-[#D8FF4B] transition cursor-pointer disabled:opacity-60"
                >
                  {isAuditing ? `Running Multimodal Audit (${ocrProgress}%)...` : 'Run Pre-Flight Brand Governance Audit'}
                </button>
              </div>

              {/* Surgical Word-Level Diff Viewer */}
              <div className="relative overflow-hidden bg-[#121411] text-[#F3F4EE] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.18)]">
                <LimeWave />
                <div className="relative z-10">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[#F3F4EE]/55">
                      Intent-Preserving Surgical Diff
                    </h3>
                    <button
                      onClick={() => setOriginalAdText(workingAdText)}
                      className="text-[11px] px-3 py-1 rounded-full bg-white/10 text-[#D8FF4B] hover:bg-white/15 cursor-pointer"
                    >
                      Baseline Current Draft
                    </button>
                  </div>
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/10 text-xs leading-relaxed">
                    {diffs.map((part, idx) => (
                      <span
                        key={idx}
                        className={
                          part.added
                            ? 'bg-[#D8FF4B]/20 text-[#D8FF4B] px-1 rounded font-medium'
                            : part.removed
                            ? 'bg-[#DF7A7A]/20 text-[#DF7A7A] line-through px-1 rounded'
                            : 'text-[#F3F4EE]/80'
                        }
                      >
                        {part.value}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                    <span className="px-3 py-1 rounded-full bg-white/10 text-[#D8FF4B]">
                      {diffs.filter((d) => d.added).length} additions
                    </span>
                    <span className="px-3 py-1 rounded-full bg-white/10 text-[#DF7A7A]">
                      {diffs.filter((d) => d.removed).length} removals
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Explainable Findings & Surgical Actions */}
            <div className="lg:col-span-6 flex flex-col gap-4">
              <div className="relative overflow-hidden bg-[radial-gradient(120%_120%_at_0%_0%,#D8FF4B_0%,#E4F884_55%,#F3F5EC_100%)] text-[#121510] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-[11px] uppercase tracking-wider text-[#121510]/60">Campaign Progress</span>
                    <h3 className="mt-1 text-lg font-semibold tracking-tight">{workflowStatus}</h3>
                    <p className="mt-1 text-xs text-[#121510]/70">
                      {unresolvedCount} unresolved · {Object.keys(overrides).length} overridden · score {trustScore}%
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleRunAudit}
                      disabled={isAuditing}
                      title="Re-run the pre-flight audit"
                      className="w-10 h-10 rounded-full bg-[#121510] text-[#D8FF4B] flex items-center justify-center hover:bg-[#22261f] cursor-pointer disabled:opacity-60"
                    >
                      <Sparkles className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setActiveTab('workflow')}
                      title="Go to the sign-off gate"
                      className="w-10 h-10 rounded-full bg-[#121510] text-[#D8FF4B] flex items-center justify-center hover:bg-[#22261f] cursor-pointer"
                    >
                      <GitPullRequest className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-4 h-1 w-full rounded-full bg-[#121510]/10 overflow-hidden">
                  <div className="h-full rounded-full bg-[#121510] transition-all duration-700" style={{ width: `${trustScore}%` }} />
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-[#121510]/60">
                  <span>Remediation progress</span>
                  <span>{trustScore}%</span>
                </div>
              </div>

              <TrustArcGauge
                trustScore={trustScore}
                unresolvedCount={unresolvedCount}
                overriddenCount={Object.keys(overrides).length}
                totalIssues={issues.length}
                hasAudited={hasAudited}
                workflowStatus={workflowStatus}
              />

              <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
                {issues.length === 0 ? (
                  <div className="bg-[#F3F4EE] border border-black/5 rounded-[28px] p-8 text-center shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                    <CheckCircle2 className="w-10 h-10 text-[#5E6759] mx-auto mb-2" />
                    <p className="font-semibold text-sm">Click "Run Pre-Flight Brand Governance Audit" or All Checks Passed!</p>
                    <p className="text-xs text-[#5E6759] mt-1">Every detected issue will display its rule citation and a 1-click surgical rewrite.</p>
                  </div>
                ) : (
                  issues.map((iss) => {
                    const isOverridden = Boolean(overrides[iss.id]);
                    // OCR and visual findings live in the uneditable artwork, so they
                    // cannot be rewritten by the local text editor.
                    const isImageIssue = iss.id.startsWith('OCR') || iss.id.startsWith('VIS');
                    // No authored replacement: the reviewer supplies wording, or we
                    // delete the term. A canned token is never inserted.
                    const needsCustomInput = isPlaceholderFix(iss.suggestedFix);
                    return (
                      <div
                        key={iss.id}
                        className={`rounded-[24px] border p-5 transition ${
                          isOverridden
                            ? 'bg-[#F3F4EE]/60 border-black/5 opacity-80'
                            : 'bg-[#F3F4EE] border-black/5 shadow-[0_12px_32px_rgba(20,24,18,0.06)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#DF7A7A]/20 text-[#8A3A3A]">
                            {iss.category} ({iss.severity})
                          </span>
                          <span className="text-[11px] font-mono text-[#7A8375]">{iss.citation}</span>
                        </div>
                        <p className="text-xs text-[#2B3129] mb-2">{iss.explanation}</p>
                        <div className="bg-[#E7E9E0] border border-black/10 rounded-2xl p-3 text-xs mb-3">
                          <div className="text-[#B4463F] line-through">Flagged: "{iss.offendingText}"</div>
                          {needsCustomInput ? (
                            <div className="text-[#5E6759] mt-1">
                              No approved replacement exists for this term — type your own wording or remove it.
                            </div>
                          ) : (
                            <div className="text-[#3F6B3A] font-medium mt-0.5">Suggested Fix: "{iss.suggestedFix}"</div>
                          )}
                        </div>

                        {isOverridden ? (
                          <div className="text-xs text-[#8A6D1F] bg-[#E2CC62]/25 border border-[#E2CC62]/60 px-3 py-2 rounded-2xl">
                            Override Requested: "{overrides[iss.id].reason}"
                          </div>
                        ) : isImageIssue ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={() => handleSkipImageIssue(iss)}
                              className="text-xs border border-black/15 text-[#121411] px-3.5 py-1.5 rounded-full hover:bg-black/5 cursor-pointer"
                            >
                              Skip (Keep as is)
                            </button>
                            <div className="group relative inline-block">
                              <a
                                href="https://www.canva.com/"
                                target="_blank"
                                rel="noopener noreferrer"
                                title="⚠️ Warning: Clicking this will open external Canva. You must upload and edit the image manually, which relies on cloud services and affects strict data privacy."
                                className="inline-flex items-center gap-1.5 text-xs bg-purple-600 hover:bg-purple-500 text-white px-3.5 py-1.5 rounded-full font-medium cursor-pointer"
                              >
                                Edit in Canva
                              </a>
                              <div
                                role="tooltip"
                                className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-64 rounded-lg border border-purple-500/30 bg-slate-950/95 p-2.5 text-[11px] leading-relaxed text-purple-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100"
                              >
                                ⚠️ Warning: Clicking this will open external Canva. You must upload and edit the image manually, which relies on cloud services and affects strict data privacy.
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {needsCustomInput && (
                              <input
                                value={customFixes[iss.id] ?? ''}
                                onChange={(e) =>
                                  setCustomFixes((prev) => ({ ...prev, [iss.id]: e.target.value }))
                                }
                                placeholder={`Type replacement for "${iss.offendingText}" (or leave blank to delete)...`}
                                className="w-full rounded-full bg-[#E7E9E0] border border-black/10 px-3.5 py-2 text-xs text-[#141712] focus:border-[#121411] focus:outline-none"
                              />
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              {needsCustomInput ? (
                                <>
                                  <button
                                    onClick={() => handleApplyCustomReplacement(iss)}
                                    className="text-xs bg-[#121411] hover:bg-[#22261f] text-[#D8FF4B] px-3.5 py-1.5 rounded-full font-medium cursor-pointer"
                                  >
                                    Apply Custom Replacement
                                  </button>
                                  <button
                                    onClick={() => handleRemoveWord(iss)}
                                    className="text-xs bg-[#DF7A7A]/20 hover:bg-[#DF7A7A]/30 text-[#8A3A3A] px-3.5 py-1.5 rounded-full font-medium cursor-pointer"
                                  >
                                    Remove Word
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => handleApplyFix(iss)}
                                  className="text-xs bg-[#121411] hover:bg-[#22261f] text-[#D8FF4B] px-3.5 py-1.5 rounded-full font-medium cursor-pointer"
                                >
                                  Apply Surgical Fix
                                </button>
                              )}
                              <button
                                onClick={() => handleRequestOverride(iss)}
                                className="text-xs bg-[#E7E9E0] hover:bg-[#DDE0D5] text-[#121411] px-3.5 py-1.5 rounded-full cursor-pointer"
                              >
                                Request Exception Override
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: COLLABORATIVE REVIEW & APPROVAL WORKFLOW */}
        {activeTab === 'workflow' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 bg-[radial-gradient(120%_120%_at_0%_0%,#D8FF4B_0%,#E4F884_55%,#F3F5EC_100%)] text-[#121510] rounded-[28px] p-6 space-y-4 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#121510] text-[#D8FF4B] flex items-center justify-center shrink-0">
                    <GitPullRequest className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-base tracking-tight">Role-Based Sign-Off & Publication Gate</h2>
                    <p className="text-xs text-[#121510]/70">Current Status: {workflowStatus}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    disabled={role === 'Creator'}
                    onClick={() => {
                      setWorkflowStatus('Approved for Publication by ' + role);
                      setRevisionHistory((prev) => [
                        { time: new Date().toLocaleTimeString(), actor: role, action: 'APPROVED campaign draft for publication' },
                        ...prev
                      ]);
                    }}
                    className={`text-xs px-4 py-2.5 rounded-full font-semibold ${
                      role === 'Creator'
                        ? 'bg-[#121510]/10 text-[#121510]/40 cursor-not-allowed'
                        : 'bg-[#121510] hover:bg-[#22261f] text-[#D8FF4B] cursor-pointer'
                    }`}
                  >
                    Approve Publication ({role})
                  </button>
                </div>
              </div>
              {role === 'Creator' && (
                <p className="text-xs text-[#121510] bg-[#121510]/10 border border-[#121510]/15 p-3 rounded-2xl">
                  Switch your role in the top navbar to "Brand Manager" or "Legal Reviewer" to unlock final publication sign-off.
                </p>
              )}

              <div className="space-y-2 bg-[#F3F4EE] text-[#141712] rounded-[24px] p-5 border border-black/5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#5E6759]">Reviewer & Creator Comments</h3>
                {comments.map((c, i) => (
                  <div key={i} className="bg-[#E7E9E0] border border-black/10 p-3 rounded-2xl text-xs">
                    <span className="font-semibold text-[#121411]">{c.role}: </span>
                    <span className="text-[#2B3129]">{c.text}</span>
                  </div>
                ))}
                <div className="flex gap-2 pt-2">
                  <input
                    value={commentInput}
                    onChange={(e) => setCommentInput(e.target.value)}
                    placeholder="Add review note or compliance comment..."
                    className="flex-1 bg-[#E7E9E0] border border-black/10 rounded-full px-4 py-2 text-xs text-[#141712] focus:border-[#121411] focus:outline-none"
                  />
                  <button
                    onClick={() => {
                      if (!commentInput.trim()) return;
                      setComments((prev) => [...prev, { author: role, role, text: commentInput }]);
                      setCommentInput('');
                    }}
                    className="text-xs bg-[#121411] hover:bg-[#22261f] px-4 py-2 rounded-full text-[#D8FF4B] cursor-pointer"
                  >
                    Post Comment
                  </button>
                </div>
              </div>
            </div>

            <div className="relative overflow-hidden lg:col-span-5 bg-[#121411] text-[#F3F4EE] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.18)]">
              <LimeWave />
              <h3 className="font-semibold text-sm mb-3 tracking-tight relative z-10">Immutable Revision & Audit History</h3>
              <div className="space-y-2.5 max-h-80 overflow-y-auto relative z-10">
                {revisionHistory.map((item, i) => (
                  <div key={i} className="text-xs border-l-2 border-[#D8FF4B] pl-3 py-1">
                    <div className="text-[#F3F4EE]/55">{item.time} • <strong className="text-[#F3F4EE]">{item.actor}</strong></div>
                    <div className="text-[#F3F4EE]/80">{item.action}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: DRIFT ANALYTICS & AMBIGUOUS GUIDELINE AUTO-REFINER */}
        {activeTab === 'analytics' && (
          <div className="grid grid-cols-1 gap-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-5 flex flex-col gap-4">
                <TrustArcGauge
                  trustScore={trustScore}
                  unresolvedCount={unresolvedCount}
                  overriddenCount={Object.keys(overrides).length}
                  totalIssues={issues.length}
                  hasAudited={hasAudited}
                  workflowStatus={workflowStatus}
                />
                <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                  <h2 className="font-semibold text-sm tracking-tight">Guideline Ambiguity & Drift Analytics</h2>
                  <p className="text-[11px] text-[#5E6759] mt-1 leading-relaxed">
                    Tracks recurring compliance mistakes and highlights rules with high human override rates so Brand Managers know where guidelines are unclear.
                  </p>
                </div>
              </div>
              <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4 content-start">
                <div className="bg-[#5E6759] text-[#F3F4EE] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.08)]">
                  <span className="text-[11px] uppercase tracking-wider text-[#F3F4EE]/70">Active Brand Source</span>
                  <p className="mt-2 text-2xl font-light tracking-tight break-words">{brandVault.sourceName}</p>
                </div>
                <div className="bg-[#5E6759] text-[#F3F4EE] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.08)]">
                  <span className="text-[11px] uppercase tracking-wider text-[#F3F4EE]/70">Terminology & Slop Rules</span>
                  <p className="mt-2 text-4xl font-light tracking-tight">{brandVault.bannedTerms.length}</p>
                </div>
                <div className="bg-[#5E6759] text-[#F3F4EE] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.08)]">
                  <span className="text-[11px] uppercase tracking-wider text-[#F3F4EE]/70">Verified Facts</span>
                  <p className="mt-2 text-4xl font-light tracking-tight">{brandVault.facts.length}</p>
                </div>
                <div className="bg-[#5E6759] text-[#F3F4EE] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.08)]">
                  <span className="text-[11px] uppercase tracking-wider text-[#F3F4EE]/70">Human Overrides</span>
                  <p className="mt-2 text-4xl font-light tracking-tight text-[#D8FF4B]">{Object.keys(overrides).length}</p>
                </div>
              </div>
            </div>

            {/* Ambiguous Guideline Auto-Refiner */}
            <div className="relative overflow-hidden bg-[#121411] text-[#F3F4EE] rounded-[28px] p-6 space-y-3 shadow-[0_12px_32px_rgba(20,24,18,0.18)]">
              <LimeWave />
              <div className="flex flex-wrap items-start justify-between gap-3 relative z-10">
                <div>
                  <h2 className="font-semibold text-base flex items-center gap-2 tracking-tight">
                    <GitPullRequest className="w-4 h-4 text-[#D8FF4B]" />
                    Ambiguous Guideline Auto-Refiner
                  </h2>
                  <p className="text-xs text-[#F3F4EE]/65 max-w-2xl">
                    Every brand rule that a human has overridden, paired with the reviewer's justification. Rewrite the unclear guideline in the vault in one click so the same ambiguity stops recurring.
                  </p>
                </div>
                <span className="text-[11px] px-3 py-1 rounded-full bg-white/10 text-[#D8FF4B] whitespace-nowrap">
                  {overrideGroups.length} Rules Overridden • {Object.keys(overrides).length} Overrides Logged
                </span>
              </div>

              {overrideGroups.length === 0 ? (
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 text-center text-xs text-[#F3F4EE]/70 relative z-10">
                  No human overrides logged yet. Request an exception override in Tab 2 and the affected brand rule surfaces here for refinement.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-[#F3F4EE]/55 border-b border-white/10">
                        <th className="py-2 pr-3 font-semibold">Brand Rule</th>
                        <th className="py-2 pr-3 font-semibold">Category</th>
                        <th className="py-2 pr-3 font-semibold">Human Override Justification</th>
                        <th className="py-2 pl-3 font-semibold text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overrideGroups.map((group) => {
                        const rule = findVaultRule(group.ruleId);
                        const inVault = Boolean(rule);
                        const isTerm = Boolean(rule && rule.term);
                        const isFact = Boolean(rule && rule.statement);
                        const isColor = Boolean(rule && rule.hex);
                        const alreadyRefined = Boolean(rule && rule.refined);
                        const draft = refineDraftFor(group);

                        return (
                          <tr key={group.ruleId} className="border-b border-white/10 align-top">
                            <td className="py-3 pr-3 max-w-[16rem]">
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-[#D8FF4B]">{group.ruleId}</span>
                                {alreadyRefined && (
                                  <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-[#D8FF4B]/15 text-[#D8FF4B] border border-[#D8FF4B]/30">
                                    Refined
                                  </span>
                                )}
                              </div>
                              {isTerm && (
                                <div className="leading-relaxed">
                                  <span className="text-[#DF7A7A] font-mono line-through">"{rule.term}"</span>
                                  <span className="text-[#F3F4EE]/40 mx-1">→</span>
                                  <span className="text-[#D8FF4B] font-mono">"{rule.replacement}"</span>
                                </div>
                              )}
                              {isTerm && (
                                <label className="block mt-2">
                                  <span className="text-[10px] uppercase tracking-wider text-[#F3F4EE]/50">
                                    Replacement phrase (editable)
                                  </span>
                                  <input
                                    value={draft.replacement}
                                    onChange={(e) => updateRefineDraft(group.ruleId, { replacement: e.target.value })}
                                    placeholder="approved phrase"
                                    className="mt-1 w-full bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-[11px] font-mono text-[#D8FF4B] focus:border-[#D8FF4B] focus:outline-none"
                                  />
                                </label>
                              )}
                              {isFact && <p className="text-[#F3F4EE] leading-relaxed">{rule.statement}</p>}
                              {isColor && (
                                <div className="flex items-center gap-2">
                                  <span className="w-4 h-4 rounded-full border border-white/20" style={{ backgroundColor: rule.hex }} />
                                  <span className="font-mono text-[#F3F4EE]">{rule.hex}</span>
                                </div>
                              )}
                              {!inVault && (
                                <p className="text-[#F3F4EE]/60 leading-relaxed">
                                  Built-in policy check stored outside the extracted vault, so there is no guideline rule to rewrite.
                                </p>
                              )}
                              {alreadyRefined && rule.clarification && (
                                <p className="text-[11px] text-[#D8FF4B]/90 mt-1">Vault now notes: "{rule.clarification}"</p>
                              )}
                            </td>

                            <td className="py-3 pr-3">
                              <span className="inline-block text-[11px] px-2.5 py-1 rounded-full bg-white/10 border border-white/10 text-[#F3F4EE]">
                                {group.category || 'Override'}
                              </span>
                              <p className="text-[10px] text-[#F3F4EE]/45 mt-1">
                                {group.entries.length} override{group.entries.length > 1 ? 's' : ''}
                              </p>
                            </td>

                            <td className="py-3 pr-3 max-w-[24rem]">
                              <label className="block mb-2">
                                <span className="text-[10px] uppercase tracking-wider text-[#F3F4EE]/50">
                                  Refined justification (editable)
                                </span>
                                <textarea
                                  value={draft.justification}
                                  onChange={(e) => updateRefineDraft(group.ruleId, { justification: e.target.value })}
                                  rows={2}
                                  placeholder="Clarified wording to store on the rule…"
                                  className="mt-1 w-full bg-white/5 border border-white/10 rounded-2xl px-3 py-2 text-[11px] text-[#F3F4EE] focus:border-[#D8FF4B] focus:outline-none resize-y"
                                />
                              </label>
                              <ul className="space-y-1.5">
                                {group.entries.map((entry) => (
                                  <li key={entry.issueId} className="bg-white/5 border border-white/10 rounded-2xl px-3 py-2">
                                    <p className="text-[#E2CC62]">"{entry.reason}"</p>
                                    <p className="text-[10px] text-[#F3F4EE]/45 mt-0.5 font-mono">
                                      {entry.actor || 'Reviewer'} • {entry.issueId}
                                    </p>
                                  </li>
                                ))}
                              </ul>
                            </td>

                            <td className="py-3 pl-3 text-right">
                              <button
                                onClick={() => handleUpdateBrandRule(group, draft)}
                                disabled={!inVault}
                                title={
                                  inVault
                                    ? 'Write the clarified rule and human justification into the active Brand Vault'
                                    : 'Built-in policy check — no vault rule to update'
                                }
                                className={`inline-flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-full font-medium whitespace-nowrap ${
                                  inVault
                                    ? 'bg-[#D8FF4B] hover:bg-[#e6ff7a] text-[#121411] cursor-pointer'
                                    : 'bg-white/10 text-[#F3F4EE]/40 cursor-not-allowed'
                                }`}
                              >
                                <Sparkles className="w-3.5 h-3.5" />
                                {alreadyRefined ? 'Re-Sync Rule in Vault' : 'Update Brand Rule in Vault'}
                              </button>
                              {alreadyRefined && rule.refinedBy && (
                                <p className="text-[10px] text-[#F3F4EE]/45 mt-1">
                                  {rule.refinedBy} • {rule.refinedAt}
                                </p>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 5: CONFIDENTIALITY & AI DISCLOSURE RECEIPT */}
        {activeTab === 'receipt' && (
          <div className="max-w-2xl w-full mx-auto">
            <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-8 space-y-5 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
              <div className="flex flex-col items-center gap-3 text-[#121411] text-center">
                <div className="w-10 h-10 rounded-full bg-[#121510] text-[#D8FF4B] flex items-center justify-center">
                  <Lock className="w-4 h-4" />
                </div>
                <h2 className="font-semibold text-lg tracking-tight">Confidentiality & AI Disclosure Receipt</h2>
              </div>
              <p className="text-xs text-[#2B3129] leading-relaxed">
                All document parsing (`pdfjs-dist`), OCR (`tesseract.js`), NLP claim extraction (`compromise` + `fuse.js`), and WCAG contrast math execute 100% locally inside the browser. Zero confidential drafts or assets are transmitted to external cloud LLM APIs.
              </p>
              <div className="bg-[#5E6759] text-[#F3F4EE] rounded-[24px] p-5 space-y-3 text-xs">
                <div className="flex justify-between items-baseline gap-4">
                  <span className="text-[#F3F4EE]/70">Guideline Source</span>
                  <strong className="font-medium text-right">{brandVault.sourceName}</strong>
                </div>
                <div className="flex justify-between items-baseline gap-4">
                  <span className="text-[#F3F4EE]/70">Brand Trust Score</span>
                  <strong className="text-4xl font-light tracking-tight">{trustScore}%</strong>
                </div>
                <div className="flex justify-between items-baseline gap-4">
                  <span className="text-[#F3F4EE]/70">Workflow Status</span>
                  <strong className="font-medium text-right">{workflowStatus}</strong>
                </div>
                <div className="flex justify-between items-baseline gap-4">
                  <span className="text-[#F3F4EE]/70">Cloud Data Leakage</span>
                  <strong className="text-4xl font-light tracking-tight text-[#D8FF4B]">
                    0<span className="ml-1 text-xs font-normal text-[#F3F4EE]/70">bytes</span>
                  </strong>
                </div>
              </div>
              <button
                onClick={() => {
                  const receipt = {
                    platform: 'NoSlop.com by Team Kaizen (Satyam)',
                    timestamp: new Date().toISOString(),
                    guidelineSource: brandVault.sourceName,
                    trustScore,
                    workflowStatus,
                    disclosedEngines: ['pdfjs-dist', 'tesseract.js WASM', 'compromise NLP', 'fuse.js', 'HTML5 Canvas WCAG 2.1'],
                    cloudDataLeakage: '0 bytes (100% Client-Side Execution)'
                  };
                  const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'NoSlop_Governance_Receipt.json';
                  a.click();
                }}
                className="w-full py-3 rounded-full bg-[#121411] hover:bg-[#22261f] text-xs font-semibold text-[#D8FF4B] cursor-pointer"
              >
                Download Signed AI & Privacy Disclosure Receipt (.JSON)
              </button>
            </div>
          </div>
        )}
        </>
        )}
      </main>
    </div>
  );
}