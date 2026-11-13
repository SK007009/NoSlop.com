import { pipeline, env } from '@huggingface/transformers';

// Model weights come from the public Hugging Face CDN and are cached by the browser
// after the first run. No document, draft or pixel ever leaves the tab; only the
// model files themselves are fetched.
env.allowLocalModels = false;
env.useBrowserCache = true;

const LLM_MODEL = 'Xenova/flan-t5-small';
const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const LOADING_MESSAGE = 'Loading on-device AI models (cached in browser after first run)...';
// A helper never blocks the UI on a cold model download for longer than this; the
// deterministic fallback answers instead and the download keeps warming in the
// background for the next call.
const MODEL_WAIT_MS = 12000;
const RETRY_COOLDOWN_MS = 20000;

// ── Status store ───────────────────────────────────────────────────────────────
// The navbar badge subscribes to this: idle → loading (%) → ready, or error when
// the CDN is unreachable. `busy` counts in-flight generations so the badge can show
// a spinner while a rewrite is being written.
const listeners = new Set();
const modelState = {
  llm: { status: 'idle', percent: 0 },
  embed: { status: 'idle', percent: 0 }
};
const cooldownUntil = { llm: 0, embed: 0 };
let busy = 0;
let lastError = '';
let snapshot = buildSnapshot();

function buildSnapshot() {
  const models = [modelState.llm, modelState.embed];
  const loading = models.some((m) => m.status === 'loading');
  const ready = models.every((m) => m.status === 'ready');
  const failed = models.some((m) => m.status === 'error');
  const percent = Math.round(models.reduce((sum, m) => sum + m.percent, 0) / models.length);
  const status = loading ? 'loading' : ready ? 'ready' : failed ? 'error' : 'idle';
  return {
    status,
    percent,
    busy,
    llm: modelState.llm.status,
    embed: modelState.embed.status,
    message:
      status === 'loading'
        ? LOADING_MESSAGE
        : status === 'ready'
          ? `Local WASM AI: Ready (flan-t5-small + MiniLM-L6-v2)`
          : status === 'error'
            ? 'Local WASM AI offline — deterministic fallback active'
            : 'Local WASM AI idle',
    error: lastError
  };
}

function publish() {
  snapshot = buildSnapshot();
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      /* a broken subscriber must not break the engine */
    }
  });
}

export function subscribeLocalAi(listener) {
  listeners.add(listener);
  try {
    listener(snapshot);
  } catch {
    /* ignore */
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getLocalAiStatus() {
  return snapshot;
}

async function withBusy(task) {
  busy += 1;
  publish();
  try {
    return await task();
  } finally {
    busy = Math.max(0, busy - 1);
    publish();
  }
}

// ── Lazy model singletons ──────────────────────────────────────────────────────
const loaders = { llm: null, embed: null };

function loadModel(kind) {
  if (loaders[kind]) return loaders[kind];

  const isLlm = kind === 'llm';
  const task = isLlm ? 'text2text-generation' : 'feature-extraction';
  const model = isLlm ? LLM_MODEL : EMBED_MODEL;
  modelState[kind] = { status: 'loading', percent: 0 };
  publish();

  const onProgress = (info) => {
    if (!info) return;
    if (info.status === 'ready') {
      modelState[kind] = { status: 'ready', percent: 100 };
      publish();
      return;
    }
    if (info.status !== 'progress') return;
    const percent = Math.min(99, Math.round(Number(info.progress) || 0));
    if (percent > modelState[kind].percent) {
      modelState[kind] = { status: 'loading', percent };
      publish();
    }
  };

  let promise;
  try {
    promise = pipeline(task, model, { dtype: 'q8', progress_callback: onProgress });
  } catch (err) {
    promise = Promise.reject(err);
  }

  loaders[kind] = promise
    .then((pipe) => {
      modelState[kind] = { status: 'ready', percent: 100 };
      publish();
      return pipe;
    })
    .catch((err) => {
      modelState[kind] = { status: 'error', percent: 0 };
      lastError = String(err?.message || err || 'model unavailable').slice(0, 160);
      publish();
      // The rejected promise is cached on purpose: a second call must fail fast
      // rather than restart an 80 MB download on every OCR line.
      throw err;
    });

  return loaders[kind];
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve a pipeline, waiting at most `waitMs` for a cold download. Returns null when
 * the model is unavailable, still downloading, or already failed — every caller then
 * uses its deterministic fallback.
 */
async function awaitModel(kind, waitMs = MODEL_WAIT_MS) {
  if (modelState[kind].status === 'error') return null;
  if (Date.now() < cooldownUntil[kind]) return null;

  const promise = loadModel(kind);
  if (modelState[kind].status === 'ready') {
    try {
      return await promise;
    } catch {
      return null;
    }
  }

  const result = await Promise.race([
    promise.then((pipe) => pipe).catch(() => null),
    delay(waitMs).then(() => undefined)
  ]);
  if (result === undefined) {
    cooldownUntil[kind] = Date.now() + RETRY_COOLDOWN_MS;
    return null;
  }
  return result;
}

/** Start both downloads in the background (called when the workspace opens). */
export function warmUpLocalAi() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve([]);
  return Promise.allSettled([loadModel('llm'), loadModel('embed')]);
}

// ── Text helpers ───────────────────────────────────────────────────────────────

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitalise(value) {
  const text = String(value || '');
  if (!/[a-z]/i.test(text.charAt(0))) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function tidySpacing(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])(?=[A-Za-z])/g, '$1 ')
    .trim();
}

function tokens(value) {
  return (String(value || '').toLowerCase().match(/[a-z0-9']+/g) || []).filter(Boolean);
}

// Share of `source`'s words that survive in `target`: 1 means nothing was dropped.
function coverage(source, target) {
  const wanted = tokens(source);
  if (!wanted.length) return 0;
  const available = new Set(tokens(target));
  let kept = 0;
  wanted.forEach((word) => {
    if (available.has(word)) kept += 1;
  });
  return kept / wanted.length;
}

function normaliseForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitiseModelOutput(value) {
  return String(value || '')
    .replace(/^(?:answer|rewrite|output|sentence)\s*:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Superlatives the deterministic pass strips when the LLM is unavailable or its
// rewrite still echoes the flagged claim.
const SUPERLATIVE_SWAPS = [
  [/\bworld'?s\s+(?:best|leading|number[\s-]one)(?:[\s-]selling)?\b/gi, 'popular'],
  [/\bbest[\s-]selling\b/gi, 'popular'],
  [/\bnumber[\s-]one\b/gi, 'leading'],
  // "#1" and "100%" end (or start) in non-word characters, so a leading or trailing
  // \b never matches them — the exact reason these claims survived every rewrite.
  [/#\s*1\b/g, 'a leading'],
  [/\b100\s*%\s*guaranteed\b/gi, 'backed by our warranty'],
  [/\b100\s*%/gi, 'high-reliability'],
  [/\bguaranteed\b/gi, ''],
  [/\bultimate\b/gi, 'complete'],
  [/\bmiracle\b/gi, 'notable'],
  [/\bunlimited\b/gi, 'flexible'],
  [/\binstant(?:ly)?\b/gi, 'quick'],
  [/\bzero[\s-]risk\b/gi, 'low-risk'],
  [/\bzero[\s-]downtime\b/gi, 'high-availability'],
  [/\bunbeatable\b/gi, 'competitive'],
  [/\bunrivall?ed\b/gi, 'distinctive'],
  [/\bgame[\s-]changing\b/gi, 'high-impact'],
  [/\bworld'?s\s+best\b/gi, 'popular']
];

const RESIDUAL_SUPERLATIVE =
  /(?:\bbest|\bfastest|\bcheapest|\bsafest|\bguaranteed|\bultimate|\bmiracle|\bunlimited|\bunrivall?ed|\bunbeatable|#\s*1|100\s*%|best[\s-]selling)/i;

export function stripSuperlatives(text) {
  let out = String(text || '');
  SUPERLATIVE_SWAPS.forEach(([pattern, replacement]) => {
    out = out.replace(pattern, replacement);
  });
  return tidySpacing(out);
}

function containsSuperlative(text) {
  return RESIDUAL_SUPERLATIVE.test(String(text || ''));
}

function deterministicCompliantRewrite(sentence, phrase, context) {
  const base = String(sentence || '').trim() || String(phrase || '').trim();
  let out = stripSuperlatives(base);
  const needle = String(phrase || '').trim();
  const stillThere = needle && out.toLowerCase().includes(needle.toLowerCase());
  const wholeSentence = needle && normaliseForCompare(needle) === normaliseForCompare(out);
  if (stillThere && !wholeSentence) {
    const replacement = String(context || '').trim();
    const usable = replacement && replacement.length <= 60 && !/:/.test(replacement);
    out = out.replace(new RegExp(escapeRegExp(needle), 'gi'), usable ? replacement : '');
  }
  return capitalise(tidySpacing(out));
}

function ensureNotEcho(candidate, phrase) {
  const value = String(candidate || '').trim();
  if (!value) return '';
  const target = normaliseForCompare(phrase);
  if (target && normaliseForCompare(value) === target) return '';
  return value;
}

// ── 1. OCR repair ──────────────────────────────────────────────────────────────

// Ad headlines get clipped at the edge of the crop: "SU" is the last two glyphs of
// "SUV", and Tesseract loses the V against the photo gradient.
function repairClippedTerms(line) {
  return String(line || '')
    .replace(/\b((?:best|top|award)[\s-]?(?:selling|rated|winner)\s+)SU\b/gi, '$1SUV')
    .replace(/\bSU(?=\s*[.!?,]?(?:\s|$))/g, 'SUV')
    .replace(/\bS\s?U\s?V\b/g, 'SUV')
    .replace(/\bS\s?U\b(?=\s*[.!?,]?(?:\s|$))/g, 'SUV');
}

// Words that are safe as the last token of a headline. A lowercase token outside
// this list, sitting after an otherwise complete clause, is OCR debris ("eben").
const COMMON_WORDS = new Set(
  `a an the and or but if in on at to of for with from by as is are was were be been being it its
   this that these those you your our we us they them their he she his her i my me not no yes all any
   some more most less than then so up down out off over under now new next last first best good great
   free buy get save sale shop order today tomorrow week month year days hours mins only just also too
   very can will may must should would could do does did done go come see try use used using make made
   take got give call click visit learn read find start join sign earn pay per plus tax fee fees emi apr
   gbp usd eur mph mpg kwh awd suv ev hp lb lbs oz kg km mi sq ft am pm utc est inc llc ltd co pro max
   mini ultra air auto car cars van truck trucks suvs model range charge miles mile road city home live
   work play win won world life time day night sun sky water food taste fresh hot cold big small old real
   true full half top high low fast slow easy hard safe clean green pure simple smart strong light dark
   white black red blue sport sports drive driving driver drivers speed power style design built quality
   price prices value deal deals offer offers limited available included standard premium luxury`
    .split(/\s+/)
    .filter(Boolean)
);

function stripTrailingOcrNoise(line) {
  const words = String(line || '').split(/\s+/).filter(Boolean);
  if (words.length < 5) return String(line || '').trim();

  const last = words[words.length - 1];
  const bare = last.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  if (!bare || bare.length < 2 || bare.length > 6) return words.join(' ');
  if (bare !== bare.toLowerCase()) return words.join(' ');
  if (COMMON_WORDS.has(bare)) return words.join(' ');

  const rest = words.slice(0, -1).join(' ');
  const restCloses = /[.!?]$/.test(rest) || words.length >= 6;
  if (!restCloses) return words.join(' ');
  return rest;
}

// Only lines that still look physically damaged are sent to the LLM; a clean line
// must never be paraphrased by a 60M-parameter model.
function looksBroken(text) {
  const value = String(text || '');
  if (/\b[b-hj-zB-HJ-Z]\b/.test(value)) return true; // a lone consonant: "S U V"
  if (/\bS\s?U\b/.test(value)) return true;
  if (/[|_~`<>]/.test(value)) return true;
  return false;
}

/**
 * Repair one OCR line. Fast deterministic clipping / trailing-noise cleanup runs
 * first, then flan-t5-small is asked to fix residual token damage — and its answer is
 * accepted only when it keeps 70% of the original words, so the model can never
 * replace a headline with an invented one.
 */
// Tesseract drops the leading letter of a word sitting on a graphic edge and splits
// ligatures, so a handful of known artifacts are corrected before the model is asked
// to reason about the whole line.
const OCR_TYPO_FIXES = [
  [/\bith\b/gi, 'with'],
  [/\bAthird\b/gi, 'A third'],
  [/\b1s\b/gi, 'is']
];

function fixOcrTypos(value) {
  return OCR_TYPO_FIXES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    String(value || '')
  );
}

export async function repairOcrTextWithLLM(rawOcrLine, options = {}) {
  const raw = String(rawOcrLine || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  try {
    const cleaned = fixOcrTypos(stripTrailingOcrNoise(repairClippedTerms(raw)));
    if (!cleaned) return raw;
    if (options.allowModel === false || !looksBroken(cleaned)) return cleaned;

    const generator = await awaitModel('llm');
    if (!generator) return cleaned;

    const prompt = `Fix any spelling or OCR errors in this advertisement headline while keeping the exact meaning: ${cleaned}`;
    const output = sanitiseModelOutput((await generator(prompt, { max_new_tokens: 40 }))?.[0]?.generated_text);
    if (!output || output.length < 6) return cleaned;
    if (coverage(cleaned, output) < 0.7) return cleaned;
    if (normaliseForCompare(output) === normaliseForCompare(cleaned)) return cleaned;
    return output;
  } catch {
    return raw;
  }
}

// ── 2. Compliant rewrite ───────────────────────────────────────────────────────

/**
 * Rewrite a flagged phrase inside its sentence as compliant, neutral copy. The
 * returned string is never identical to `flaggedPhrase`: the deterministic pass
 * strips superlatives, the LLM pass is validated for overlap, and the final guard
 * removes the flagged wording outright.
 */
export async function generateCompliantRewriteWithLLM(
  flaggedPhrase,
  fullSentence,
  violationType = '',
  ruleContext = ''
) {
  const phrase = String(flaggedPhrase || '').trim();
  const sentence = String(fullSentence || '').trim() || phrase;
  if (!sentence) return '';

  const fallback =
    ensureNotEcho(deterministicCompliantRewrite(sentence, phrase, ruleContext), phrase) || '';

  return withBusy(async () => {
    try {
      const generator = await awaitModel('llm');
      if (generator) {
        const prompt =
          'Rewrite this advertisement sentence into compliant, neutral, substantiated marketing copy. ' +
          'Remove superlatives and banned words but keep the same product and meaning. ' +
          `Sentence: ${sentence}`;
        const output = sanitiseModelOutput(
          (await generator(prompt, { max_new_tokens: 45 }))?.[0]?.generated_text
        );
        if (output && coverage(sentence, output) >= 0.45) {
          const repaired = stripSuperlatives(
            phrase && output.toLowerCase().includes(phrase.toLowerCase())
              ? output.replace(new RegExp(escapeRegExp(phrase), 'gi'), '')
              : output
          );
          const clean = ensureNotEcho(repaired, phrase);
          if (clean && !containsSuperlative(clean) && coverage(sentence, clean) >= 0.45) {
            return clean;
          }
        }
      }
      if (violationType && /banned|terminology/i.test(violationType) && !fallback) {
        return ensureNotEcho(stripSuperlatives(sentence), phrase);
      }
      return fallback;
    } catch {
      return fallback;
    }
  });
}

// ── 3. Ambiguous rule refinement ───────────────────────────────────────────────

/**
 * Draft a clearer version of an ambiguous brand rule that folds in the exceptions a
 * reviewer has already approved.
 */
export async function refineAmbiguousRuleWithLLM(originalRule, overrideJustifications = []) {
  const rule = String(originalRule || '').trim();
  const exceptions = (Array.isArray(overrideJustifications)
    ? overrideJustifications
    : [overrideJustifications]
  )
    // Reviewers often type the label themselves ("Approved exception: …"); strip it
    // so the refined rule does not read "Approved exception: Approved exception: …".
    .map((entry) =>
      String(entry || '')
        .replace(/^\s*(?:approved\s+)?(?:exception|override)\s*:\s*/i, '')
        .replace(/[.;\s]+$/, '')
        .trim()
    )
    .filter(Boolean)
    .slice(0, 4);

  const ruleSentence = /\.\s*$/.test(rule) ? rule : `${rule}.`;
  const deterministic =
    ruleSentence +
    (exceptions.length ? ` Approved exception: ${exceptions.join('; ')}.` : '') +
    ' This wording governs every future review.';

  if (!rule) return deterministic;

  return withBusy(async () => {
    try {
      const generator = await awaitModel('llm');
      if (!generator) return deterministic;

      const prompt =
        'Rewrite this brand guideline as one complete, unambiguous rule sentence that still states the rule and folds in the approved exception. ' +
        `Rule: ${rule} ` +
        (exceptions.length ? `Approved exception: ${exceptions.join('; ')}.` : '');
      const output = sanitiseModelOutput(
        (await generator(prompt, { max_new_tokens: 80 }))?.[0]?.generated_text
      );
      if (!output || output.length < 25) return deterministic;
      if (normaliseForCompare(output) === normaliseForCompare(rule)) return deterministic;
      // A fragment that only paraphrases the exception ("Exceptions: …") is not a
      // refined rule: it must still carry the rule's own subject words.
      if (/^(?:exceptions?|answer|rewrite|output)\s*:/i.test(output)) return deterministic;
      const ruleContent = tokens(rule).filter((token) => token.length >= 4);
      const kept = ruleContent.filter((token) => tokens(output).includes(token)).length;
      if (ruleContent.length && kept / ruleContent.length < 0.6) return deterministic;
      return capitalise(output);
    } catch {
      return deterministic;
    }
  });
}

// ── 4. Semantic claim similarity ───────────────────────────────────────────────

const CLAIM_PATTERN =
  /\d|\b(?:best|fastest|cheapest|safest|most|leading|guaranteed|always|never|every|all|unlimited|zero|100%|#1|up to|more than|less than|twice|double|world'?s)\b/i;

const ABSOLUTE_PATTERN =
  /\b(?:always|never|guaranteed|100%|zero|every|all|unlimited|no\.?\s*1|#1|best|fastest|cheapest|safest|most|world'?s)\b/i;

function isClaimSentence(sentence) {
  return CLAIM_PATTERN.test(sentence);
}

function isBoldClaim(sentence) {
  return /\d/.test(sentence) || ABSOLUTE_PATTERN.test(sentence);
}

function numbersIn(value) {
  return (String(value || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ''));
}

// The raw token, still formatted the way the guideline prints it: "40,000+".
function rawNumbersIn(value) {
  return String(value || '').match(/\d[\d,]*(?:\.\d+)?\+?/g) || [];
}

function numberValue(token) {
  return Number(String(token).replace(/[^\d.]/g, '')) || 0;
}

// "#1" and "No. 1" are rankings, not quantities. Treating them as the divergent
// metric rewrote the rank instead of the claim: "#40000 miracle diet burger".
function isRankingToken(sentence, token) {
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:#|\\bno\\.?\\s*)\\s*${escaped}(?![\\d,])`, 'i').test(sentence);
}

function dot(a, b) {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
}

function lexicalVectors(texts) {
  const vocab = new Map();
  const tokenised = texts.map((text) => tokens(text));
  tokenised.forEach((list) => {
    list.forEach((token) => {
      if (!vocab.has(token)) vocab.set(token, vocab.size);
    });
  });

  return tokenised.map((list) => {
    const vector = new Array(vocab.size).fill(0);
    list.forEach((token) => {
      const index = vocab.get(token);
      if (index !== undefined) vector[index] += 1;
    });
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm) || 1;
    return vector.map((value) => value / norm);
  });
}

async function embedTexts(texts) {
  const extractor = await awaitModel('embed', MODEL_WAIT_MS * 1.5);
  if (extractor) {
    try {
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const rows =
        typeof output?.tolist === 'function'
          ? output.tolist()
          : [Array.from(output?.data || [])];
      if (rows.length === texts.length && rows.every((row) => Array.isArray(row) && row.length)) {
        return { vectors: rows, method: 'embeddings' };
      }
    } catch {
      /* fall through to the lexical estimate */
    }
  }
  return { vectors: lexicalVectors(texts), method: 'lexical' };
}

async function entailmentVerdict(premise, hypothesis) {
  const generator = await awaitModel('llm', 8000);
  if (!generator) return null;
  try {
    const prompt = `Premise: ${premise} Hypothesis: ${hypothesis} Does the premise support or contradict the hypothesis?`;
    const answer = sanitiseModelOutput(
      (await generator(prompt, { max_new_tokens: 8 }))?.[0]?.generated_text
    ).toLowerCase();
    if (/contradict|does not support|no\b/.test(answer)) return 'contradict';
    if (/support|yes\b/.test(answer)) return 'support';
    return null;
  } catch {
    return null;
  }
}

function findDivergence(sentence, factStatement) {
  const reasons = [];
  const adNumbers = numbersIn(sentence);
  const factNumbers = numbersIn(factStatement);
  if (adNumbers.length && factNumbers.length && !adNumbers.some((n) => factNumbers.includes(n))) {
    reasons.push('number');
  }
  if (ABSOLUTE_PATTERN.test(sentence) && !ABSOLUTE_PATTERN.test(factStatement)) {
    reasons.push('absolute framing');
  }
  if (
    /\b(?:all|every|any|worldwide|global(?:ly)?|unlimited|everyone)\b/i.test(sentence) &&
    !/\b(?:all|every|worldwide|global(?:ly)?)\b/i.test(factStatement)
  ) {
    reasons.push('scope');
  }
  return reasons;
}

function buildContradictionIssue(sentence, fact, index, similarity, divergence, method) {
  const factNumbers = numbersIn(fact.statement);
  const adNumbers = numbersIn(sentence);
  let fix = '';
  if (divergence.includes('number') && factNumbers.length && adNumbers.length) {
    const factRaw = rawNumbersIn(fact.statement);
    const draftDivergent = rawNumbersIn(sentence)
      .filter((token) => !isRankingToken(sentence, token))
      .filter((token) => !factNumbers.includes(token.replace(/,/g, '')));
    if (draftDivergent.length) {
      const distanceToFacts = (token) =>
        Math.min(...factNumbers.map((f) => Math.abs(numberValue(token) - numberValue(f))));
      // Swap the number that actually conflicts with the guideline — "90,000" against
      // "40,000"> — instead of whichever digit happens to come first.
      const wrong = draftDivergent.reduce(
        (closest, candidate) =>
          distanceToFacts(candidate) < distanceToFacts(closest) ? candidate : closest,
        draftDivergent[0]
      );
      const rightIndex = factNumbers.reduce(
        (best, value, i, list) =>
          Math.abs(numberValue(value) - numberValue(wrong)) <
          Math.abs(numberValue(list[best]) - numberValue(wrong))
            ? i
            : best,
        0
      );
      const right =
        factRaw.find((token) => numberValue(token) === numberValue(factNumbers[rightIndex])) ||
        factNumbers[rightIndex];
      const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      fix = sentence.replace(new RegExp(`(?<![\\d,])${escaped}(?![\\d,])`), right);
    }
  }
  if (!fix || normaliseForCompare(fix) === normaliseForCompare(sentence)) {
    fix = stripSuperlatives(sentence);
  }
  if (!fix || normaliseForCompare(fix) === normaliseForCompare(sentence)) {
    fix = fact.statement;
  }

  return {
    ruleId: fact.id || `FACT-${index + 1}`,
    category: 'Semantic Claim Contradiction / Unsubstantiated Paraphrase',
    severity: 'High',
    offendingText: sentence,
    explanation:
      `Draft sentence "${sentence}" paraphrases verified fact #${index + 1} but diverges on ${divergence.join(' and ')}. ` +
      `Cosine Similarity: ${similarity.toFixed(2)} against Fact #${index + 1} ("${fact.statement}").` +
      (method === 'lexical' ? ' (lexical vector estimate — embedding model still loading)' : ''),
    citation: fact.citation || 'Brand Fact Ledger',
    suggestedFix: fix,
    similarity: Number(similarity.toFixed(2)),
    method
  };
}

function buildUnsubstantiatedIssue(sentence, similarity, method) {
  const fix = stripSuperlatives(sentence);
  return {
    ruleId: 'SEMANTIC-UNSUB',
    category: 'Semantic Claim Contradiction / Unsubstantiated Paraphrase',
    severity: 'High',
    offendingText: sentence,
    explanation:
      `Bold factual claim "${sentence}" has no semantically comparable entry in the Fact Ledger ` +
      `(best Cosine Similarity: ${similarity.toFixed(2)}).` +
      (method === 'lexical' ? ' (lexical vector estimate — embedding model still loading)' : ''),
    citation: 'Fact Ledger — zero supporting evidence',
    suggestedFix: normaliseForCompare(fix) === normaliseForCompare(sentence) ? '' : fix,
    similarity: Number(similarity.toFixed(2)),
    method
  };
}

/**
 * Compare each advertising claim against the brand's own fact ledger in vector space.
 * A paraphrase that discusses the same product (0.38–0.78) but moves the numbers or
 * absolutes is a contradiction; a bold claim with almost no semantic neighbour
 * (<0.25) is unsubstantiated. Both cite the similarity score in the issue card.
 */
export async function checkSemanticClaimSimilarity(adSentences, brandFacts = []) {
  const sentences = [...new Set((adSentences || []).map((s) => String(s || '').trim()))]
    .filter((s) => s.length >= 12 && isClaimSentence(s))
    .slice(0, 12);
  const facts = (Array.isArray(brandFacts) ? brandFacts : [])
    .filter((fact) => fact && String(fact.statement || '').trim())
    .slice(0, 30);

  if (!sentences.length || !facts.length) return [];

  return withBusy(async () => {
    try {
      const { vectors, method } = await embedTexts([
        ...sentences,
        ...facts.map((fact) => fact.statement)
      ]);
      const sentenceVectors = vectors.slice(0, sentences.length);
      const factVectors = vectors.slice(sentences.length);
      const results = [];
      let entailmentChecks = 0;

      for (let i = 0; i < sentences.length; i += 1) {
        const sentence = sentences[i];
        let bestIndex = -1;
        let bestScore = -1;
        factVectors.forEach((vector, index) => {
          const score = dot(sentenceVectors[i], vector);
          if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        });
        if (bestIndex < 0) continue;

        const fact = facts[bestIndex];
        const similarity = Math.max(0, Math.min(1, bestScore));
        const divergence = findDivergence(sentence, fact.statement);

        if (similarity >= 0.38 && similarity <= 0.78 && divergence.length) {
          let contradicted = true;
          // A pure wording difference (no number conflict) gets one quick entailment
          // vote so a legitimate paraphrase is not flagged as a contradiction.
          if (entailmentChecks < 3 && !divergence.includes('number')) {
            entailmentChecks += 1;
            const verdict = await entailmentVerdict(fact.statement, sentence);
            if (verdict === 'support') contradicted = false;
          }
          if (contradicted) {
            results.push(
              buildContradictionIssue(sentence, fact, bestIndex, similarity, divergence, method)
            );
          }
        } else if (similarity < 0.25 && isBoldClaim(sentence)) {
          results.push(buildUnsubstantiatedIssue(sentence, similarity, method));
        }
      }

      return results;
    } catch {
      return [];
    }
  });
}

// ── 5. CLIP visual scene verification ──────────────────────────────────────────
// Everything above reads words, or pixels as colour swatches. CLIP reads the scene:
// an athlete poster and a coffee counter are separable in joint image-text space even
// when OCR finds no wordmark, which is exactly the false positive that made a
// logo-only campaign look like a cross-brand upload.
//
// ViT-B/32 is ~90 MB, so it loads on the first uploaded banner and never at boot:
// warmUpLocalAi() deliberately leaves this pipeline alone.
const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
// A cold download must not freeze an audit. The cached promise keeps warming in the
// background, so the next banner gets the real answer instead of a spinner.
const CLIP_WAIT_MS = 20000;
// Deliberately narrow: a heavily-texted, well-composed ad is not "clutter", and the
// old wording was scoring legitimate brand campaigns as the foil.
const UNRELATED_SCENE_LABEL = 'unrelated text-heavy document, blank background, or visual noise';

const clipClassifiers = new Map();

function getClipClassifier(onProgress, modelId = CLIP_MODEL) {
  if (clipClassifiers.has(modelId)) return clipClassifiers.get(modelId);
  const promise = pipeline('zero-shot-image-classification', modelId, {
    dtype: 'q8',
    progress_callback: onProgress
  }).catch((err) => {
      // Unlike the text models, a CLIP failure is recoverable: drop the cached
      // rejection so a later banner can retry instead of failing forever.
      clipClassifiers.delete(modelId);
      throw err;
    });
  clipClassifiers.set(modelId, promise);
  return promise;
}

// Keyword source strings, not RegExp literals: a global regex carries lastIndex
// between calls, which silently skips matches on the second domain probe.
const CLIP_DOMAIN_PROFILES = [
  {
    id: 'athletic',
    label: 'athletic sportswear advertisement, athlete portrait, sports apparel, and victory campaign',
    foil: 'athletic sportswear apparel and athlete sports photography',
    keywords:
      '(?:nike|adidas|puma|sport|sports|sportswear|athlet[a-z]*|swoosh|footwear|apparel|running|runner|training)'
  },
  {
    id: 'coffee',
    label: 'iced coffee cup, cafe beverage, food and drink product advertisement, or restaurant brand logo',
    foil: 'coffee beverage and cafe food photography',
    keywords:
      '(?:starbucks|mcdonald[a-z]*|coffee|espresso|latte|roast|cafe|café|burger|qsr|siren|beverage|drink|menu)'
  },
  {
    id: 'automotive',
    label: 'modern electric vehicle, car, SUV, automotive road photography, and transport advertisement',
    foil: 'modern automotive vehicle and car photography',
    keywords: '(?:tesla|vehicle|suv|cars?|electric|ev|miles?|epa|automotive|charging|sedan|awd|mph)'
  },
  {
    id: 'digital',
    label: 'digital software interface, music streaming, modern graphic design illustration, and tech brand ad',
    foil: 'digital software interface and tech brand graphic',
    keywords:
      '(?:mailchimp|spotify|software|app|apps|music|audio|marketing|saas|platform|digital|dashboard)'
  },
  {
    id: 'energy',
    label:
      'renewable energy infrastructure, solar farm, power transmission grid, and utility brand advertisement',
    foil: 'renewable energy infrastructure, solar panels and power grid photography',
    keywords:
      '(?:adani|energy|energies|solar|renewable|wind|power|grid|utility|utilities|infrastructure|transmission|substation|megawatt|gw)'
  }
];

function ruleText(rule) {
  if (!rule) return '';
  if (typeof rule === 'string') return rule;
  return [rule.text, rule.rule, rule.description].filter(Boolean).join(' ');
}

/**
 * Which visual domain does this vault describe? The masthead outweighs the body: a
 * coffee deck may quote "athlete" once in a sustainability paragraph, but its brand
 * name and file name say coffee.
 */
function inferVisualDomain(brandVault) {
  const nameText = [brandVault?.brandName, brandVault?.sourceName].filter(Boolean).join(' ');
  const evidence = [
    ...(Array.isArray(brandVault?.facts) ? brandVault.facts.map((fact) => fact?.statement) : []),
    ...(Array.isArray(brandVault?.rules) ? brandVault.rules.map(ruleText) : []),
    String(brandVault?.rawText || '').slice(0, 4000)
  ]
    .filter(Boolean)
    .join(' ');

  let best = null;
  let bestScore = 0;
  CLIP_DOMAIN_PROFILES.forEach((profile) => {
    const nameHits = (nameText.match(new RegExp(profile.keywords, 'gi')) || []).length;
    const evidenceHits = (evidence.match(new RegExp(profile.keywords, 'gi')) || []).length;
    const score = nameHits * 3 + Math.min(evidenceHits, 3);
    if (score > bestScore) {
      best = profile;
      bestScore = score;
    }
  });
  return bestScore >= 1 ? best : null;
}

/**
 * Four labels: the expected scene, two contrasting domains, and an explicit off-brand
 * bucket. Without that last label every image is forced to resemble a brand domain,
 * which is how stock photos score as on-brand.
 */
// Universal industry traps: generic vocabulary a brand book uses for its own category,
// mapped to the visual scenes that should NOT count as on-brand. Nothing here names a
// brand, so an unknown utility, an Adani deck and a Tesla deck all resolve through
// the same keywords.
const INDUSTRY_FOIL_MAP = [
  {
    id: 'footwear',
    keywords: ['shoe', 'shoes', 'footwear', 'sneaker', 'sneakers', 'athletic', 'sports', 'sportswear'],
    foils: [
      'a photograph of off-brand shoes',
      'a competitor shoe advertisement',
      'generic athletic footwear'
    ]
  },
  // Drinks sit before restaurant food: a packaged-coffee ad is not a burger meal, and
  // "restaurant meal" foils were too weak to pull a Nescafé creative off a Starbucks
  // target. This category is first-match preferred, so coffee vocabulary lands here.
  {
    id: 'beverage_cafe',
    keywords: ['coffee', 'cafe', 'café', 'beverage', 'drink', 'drinks', 'espresso', 'tea', 'roast'],
    foils: [
      'a competitor coffee advertisement',
      'a generic cup of coffee',
      'a photograph of packaged supermarket coffee',
      'an instant coffee advertisement',
      'a Nescafé ad'
    ]
  },
  {
    id: 'food_qsr',
    keywords: ['food', 'burger', 'restaurant', 'meal', 'qsr', 'menu'],
    foils: [
      'a generic food advertisement',
      'a competitor restaurant meal',
      'a stock photo of food'
    ]
  },
  {
    id: 'automotive',
    keywords: [
      'auto',
      'automotive',
      'car',
      'cars',
      'vehicle',
      'vehicles',
      'driving',
      'motors',
      'tesla',
      'fuel',
      'ev',
      'electric'
    ],
    foils: [
      'a photograph of a car',
      'a generic automobile advertisement',
      'an electric vehicle on a road',
      'a BYD car',
      'a photograph of a BYD vehicle'
    ]
  },
  {
    id: 'tech_energy',
    keywords: ['software', 'energy', 'infrastructure', 'power', 'cloud', 'app', 'apps', 'platform', 'saas'],
    foils: [
      'retail consumer electronics',
      'a generic corporate building',
      'unrelated technology infrastructure'
    ]
  }
];

// Scenes every brand must beat, whatever its category.
const BASE_FOILS = [
  'a blank background',
  'a generic stock photograph',
  'an unrelated product advertisement'
];

// Whole-word matching: a substring test would fire "app" on "apparel" and route a
// sportswear vault into the technology bucket.
function industryFoils(brandVault) {
  const vaultText = JSON.stringify(brandVault || {}).toLowerCase();
  const industry = INDUSTRY_FOIL_MAP.find((entry) =>
    entry.keywords.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(vaultText))
  );
  return industry ? [...BASE_FOILS, ...industry.foils] : [...BASE_FOILS];
}

// Foils come from the *other* domains, never from the target's own vocabulary: a
// coffee banner is scored against automotive, sportswear and software scenes, which
// keeps the probability mass off near-synonyms of the correct answer.
function buildClipCandidates(targetLabel, activeProfile, brandVault) {
  const domainFoils = CLIP_DOMAIN_PROFILES.filter((profile) => profile.id !== activeProfile?.id)
    .map((profile) => profile.foil)
    .filter(Boolean)
    .slice(0, 3);
  return [
    ...new Set([
      targetLabel,
      ...industryFoils(brandVault),
      ...domainFoils,
      UNRELATED_SCENE_LABEL
    ])
    // Deep enough for target + 3 base + 5 cafe foils + 3 domain foils + unrelated,
    // so the off-brand bucket is never the label that gets truncated away.
  ].slice(0, 14);
}

function normaliseClipScores(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((row) => ({
      label: String(row?.label || '').trim(),
      score: Number(row?.score) || 0
    }))
    .filter((row) => row.label);
}

/**
 * Score an uploaded banner against the active vault's visual domain with CLIP
 * ViT-B/32. Returns null — never throws — when the model is still downloading, the
 * browser is offline, or inference fails, so the deterministic audit always finishes.
 */
export async function analyzeBannerVisualSceneWithCLIP(
  imageSource,
  brandVault,
  onStatusUpdate = () => {},
  modelId = CLIP_MODEL
) {
  if (!imageSource) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  const profile = inferVisualDomain(brandVault);
  const brandName = String(brandVault?.brandName || '').trim();
  // The target is the brand's own domain, named plainly ("Starbucks coffee cup, cafe
  // beverage…") — not a generic commercial graphic every upload can resemble.
  const targetLabel = profile
    ? `${brandName ? `${brandName} ` : ''}${profile.label}`
    : `${brandName || 'corporate'} official brand advertisement, product showcase, and clean commercial graphic`;
  const candidateLabels = buildClipCandidates(targetLabel, profile, brandVault);

  let reported = 0;
  const report = (percent) => {
    const value = Math.min(100, Math.round(Number(percent) || 0));
    if (value <= reported) return;
    reported = value;
    try {
      onStatusUpdate(value);
    } catch {
      /* a UI callback must not break the audit */
    }
  };

  let classifier;
  try {
    classifier = await Promise.race([
      getClipClassifier((info) => {
        if (info?.status === 'progress') report(info.progress);
        if (info?.status === 'ready') report(100);
      }, modelId),
      delay(CLIP_WAIT_MS).then(() => null)
    ]);
  } catch {
    return null;
  }
  if (!classifier) return null;

  try {
    const scored = normaliseClipScores(await classifier(imageSource, candidateLabels));
    if (!scored.length) return null;

    const target = scored.find((row) => row.label === targetLabel);
    const top = [...scored].sort((a, b) => b.score - a.score)[0];
    const brandScene = Math.max(0, Math.min(1, target?.score ?? 0));
    const topScore = Math.max(0, Math.min(1, top.score));

    return {
      brandSceneScore: Math.round(brandScene * 100),
      topDetectedScene: top.label,
      topScore: Math.round(topScore * 100),
      // The scene matching the expected label is proof on its own; 0.28 is a quarter
      // of the probability mass, above what four labels hand a random image.
      isVisualMatch: top.label === targetLabel || brandScene >= 0.28,
      targetLabel,
      candidateLabels,
      domain: profile?.id || 'generic'
    };
  } catch {
    return null;
  }
}

// ── 6. Logo patch geometry ─────────────────────────────────────────────────────
// Shared by the vault compiler (which crops the reference mark off page 1) and the
// banner audit (which finds the mark on the creative). Pure canvas maths, no model:
// a logo is a compact graphic cluster, and its shape survives a JPEG round-trip far
// better than its colours do.
const LOGO_WORK_EDGE = 240;
const LOGO_BACKGROUND_TOLERANCE = 60;
const LOGO_CELL_TARGET = 48;

function clampChannel(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function hexOf(r, g, b) {
  return (
    '#' +
    [r, g, b]
      .map((v) => clampChannel(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

// Sum-of-channels distance: cheap, and the 0–765 range makes the tolerance readable.
function rgbDistance(r1, g1, b1, r2, g2, b2) {
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}

function luminanceOf(r, g, b) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The mark on a page, as a crop plus a fingerprint.
 *
 * A brand book page is mostly paper, so the page's own border average is the
 * background — assuming white breaks on the black posters and dark theme spreads
 * half of them lead with. Everything that differs from that background is ink; the
 * largest *compact* cluster of ink cells is the emblem, and a line of type is
 * rejected by the box-height window (a headline strip is 3–5% of the page tall).
 */
export function extractLogoFromCanvas(canvas, pageText = '', options = {}) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const {
    preferEdges = false,
    flatGraphic = false,
    maxWidthRatio = 0.92,
    maxDimension = 240
  } = options;
  // The mark lives on the page that names it. Elsewhere — a "PURPOSE" or
  // "INTRODUCTION" page — the largest dark shape is a paragraph of body copy, so the
  // geometry windows tighten instead of accepting four centered lines of type.
  const pageCopy = typeof pageText === 'string' ? pageText : '';
  const logoPage = /\b(logo|swoosh|symbol|wordmark|brand mark|emblem|lockup|clear space|siren)\b/i.test(
    pageCopy
  );
  const minHeightRatio = options.minHeightRatio ?? (logoPage ? 0.055 : 0.08);
  const maxHeightRatio = options.maxHeightRatio ?? 0.65;
  const maxAspect = logoPage ? 3.6 : 3.2;
  const minAspect = 0.35;
  const declaredBrand = String(options.brandName || '').trim();
  const pageNamesBrand =
    declaredBrand.length >= 3 &&
    new RegExp(`\\b${declaredBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(pageCopy);

  const workingScale = Math.min(1, LOGO_WORK_EDGE / Math.max(canvas.width, canvas.height));
  const w = Math.max(12, Math.round(canvas.width * workingScale));
  const h = Math.max(12, Math.round(canvas.height * workingScale));

  let pixels;
  try {
    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const workCtx = work.getContext('2d', { willReadFrequently: true });
    workCtx.drawImage(canvas, 0, 0, w, h);
    pixels = workCtx.getImageData(0, 0, w, h).data;
  } catch {
    // Tainted canvas (remote asset without CORS headers) — no reference logo.
    return null;
  }

  // Background: average of the outer frame, not "white".
  let frameR = 0;
  let frameG = 0;
  let frameB = 0;
  let frameCount = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x > 2 && x < w - 3 && y > 2 && y < h - 3) continue;
      const i = (y * w + x) * 4;
      frameR += pixels[i];
      frameG += pixels[i + 1];
      frameB += pixels[i + 2];
      frameCount += 1;
    }
  }
  if (!frameCount) return null;
  const bg = { r: frameR / frameCount, g: frameG / frameCount, b: frameB / frameCount };

  const cell = Math.max(2, Math.round(w / LOGO_CELL_TARGET));
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const cellArea = cell * cell;
  const cellInk = new Uint16Array(cols * rows);
  const dense = new Uint8Array(cols * rows);

  if (flatGraphic) {
    // A photograph has no page background, so an ink mask marks the entire frame.
    // Marks and flat type are the exception: locally uniform patches that sit far
    // from the colour of the cells around them. That is a white swoosh on a photo of
    // an athlete — and it is not skin, sky or foliage, which are never flat.
    const meanR = new Float32Array(cols * rows);
    const meanG = new Float32Array(cols * rows);
    const meanB = new Float32Array(cols * rows);

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x0 = col * cell;
        const y0 = row * cell;
        const x1 = Math.min(w, x0 + cell);
        const y1 = Math.min(h, y0 + cell);
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const p = (y * w + x) * 4;
            r += pixels[p];
            g += pixels[p + 1];
            b += pixels[p + 2];
            n += 1;
          }
        }
        if (!n) continue;
        r /= n;
        g /= n;
        b /= n;
        const index = row * cols + col;
        meanR[index] = r;
        meanG[index] = g;
        meanB[index] = b;
      }
    }

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        let nr = 0;
        let ng = 0;
        let nb = 0;
        let neighbours = 0;
        // A ring three cells out, minus the 3x3 centre, stands in for a blur: a photo's
        // own gradient predicts it, so smooth texture cancels out, while a white mark
        // only two cells wide still stands clear of its surroundings.
        for (let dy = -3; dy <= 3; dy += 1) {
          for (let dx = -3; dx <= 3; dx += 1) {
            if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;
            const nc = col + dx;
            const nrow = row + dy;
            if (nc < 0 || nrow < 0 || nc >= cols || nrow >= rows) continue;
            const ni = nrow * cols + nc;
            nr += meanR[ni];
            ng += meanG[ni];
            nb += meanB[ni];
            neighbours += 1;
          }
        }
        if (neighbours < 8) continue;
        const separation =
          Math.abs(meanR[index] - nr / neighbours) +
          Math.abs(meanG[index] - ng / neighbours) +
          Math.abs(meanB[index] - nb / neighbours);
        if (separation < 60) continue;
        dense[index] = 1;
        cellInk[index] = cellArea;
      }
    }
  } else {
    const ink = new Uint8Array(w * h);
    let inkTotal = 0;
    for (let i = 0; i < w * h; i += 1) {
      const p = i * 4;
      if (pixels[p + 3] < 24) continue;
      if (
        rgbDistance(pixels[p], pixels[p + 1], pixels[p + 2], bg.r, bg.g, bg.b) >
        LOGO_BACKGROUND_TOLERANCE
      ) {
        ink[i] = 1;
        inkTotal += 1;
      }
    }
    // A page with no graphic at all is not a logo page.
    if (inkTotal < w * h * 0.004) return null;

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!ink[y * w + x]) continue;
        const col = Math.min(cols - 1, Math.floor(x / cell));
        const row = Math.min(rows - 1, Math.floor(y / cell));
        cellInk[row * cols + col] += 1;
      }
    }
    for (let i = 0; i < cellInk.length; i += 1) {
      if (cellInk[i] / cellArea >= 0.15) dense[i] = 1;
    }
  }

  // Connected clusters of dense cells; 8-neighbour so a hollow emblem stays whole.
  const visited = new Uint8Array(cols * rows);
  const clusters = [];
  for (let start = 0; start < dense.length; start += 1) {
    if (!dense[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    let minCol = cols;
    let maxCol = 0;
    let minRow = rows;
    let maxRow = 0;
    while (stack.length) {
      const index = stack.pop();
      const col = index % cols;
      const row = Math.floor(index / cols);
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nc = col + dx;
          const nr = row + dy;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const next = nr * cols + nc;
          if (!dense[next] || visited[next]) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    clusters.push({ minCol, maxCol, minRow, maxRow });
  }
  if (!clusters.length) return null;

  const pageW = canvas.width;
  const pageH = canvas.height;
  const toPageX = (value) => (value * cell * pageW) / w;
  const toPageY = (value) => (value * cell * pageH) / h;

  const ranked = [];
  clusters.forEach((cluster) => {
    const x0 = toPageX(cluster.minCol);
    const y0 = toPageY(cluster.minRow);
    const x1 = Math.min(pageW, toPageX(cluster.maxCol + 1));
    const y1 = Math.min(pageH, toPageY(cluster.maxRow + 1));
    const boxW = x1 - x0;
    const boxH = y1 - y0;
    if (boxW < pageW * 0.03 || boxH < pageH * 0.03) return;
    if (boxH > pageH * maxHeightRatio) return;
    if (boxW > pageW * maxWidthRatio) return;
    // A full-page product shot (a car, a shoe, a lifestyle photo) is artwork, not a
    // mark: anything larger than a third of the page is rejected outright.
    if ((boxW * boxH) / (pageW * pageH) > 0.35) return;

    // Horizontal scanline bands: ink rows separated by blank leading. A body
    // paragraph sets as three or more thin rows; a swoosh, a siren, or a one-line
    // wordmark like "adani" (optionally with a tagline beneath it) sets as one or two.
    let rowBands = 0;
    let inBand = false;
    for (let row = cluster.minRow; row <= cluster.maxRow; row += 1) {
      let rowInk = 0;
      for (let col = cluster.minCol; col <= cluster.maxCol; col += 1) {
        rowInk += cellInk[row * cols + col];
      }
      if (rowInk > 0) {
        if (!inBand) {
          rowBands += 1;
          inBand = true;
        }
      } else {
        inBand = false;
      }
    }
    // Three or more stacked rows of type is a paragraph, never a logo.
    if (rowBands >= 3) return;

    // Tightness: how much of the cluster's box is actually graphic? A paragraph of
    // type is dense cells separated by leading, so its fill stays low.
    let inkInBox = 0;
    for (let row = cluster.minRow; row <= cluster.maxRow; row += 1) {
      for (let col = cluster.minCol; col <= cluster.maxCol; col += 1) {
        inkInBox += cellInk[row * cols + col];
      }
    }
    const cellsInBox =
      (cluster.maxCol - cluster.minCol + 1) * (cluster.maxRow - cluster.minRow + 1) * cellArea;
    const fill = inkInBox / Math.max(1, cellsInBox);

    // A wordmark is wide by design: "adani" and "SONY" measure 3:1 to 6:1 and set a
    // single line, so the wide window only asks that the letters genuinely fill the
    // box. Emblems keep the compact window and the low fill floor.
    const candidateAspect = boxW / Math.max(1, boxH);
    if (rowBands <= 2) {
      if (candidateAspect > 6.5 || candidateAspect < 0.4) return;
      if (boxH < pageH * Math.min(minHeightRatio, 0.05)) return;
      if (candidateAspect >= 2.2 && fill < 0.15) return;
      if (fill < 0.05) return;
    } else {
      if (boxH < pageH * minHeightRatio) return;
      if (candidateAspect > maxAspect || candidateAspect < minAspect) return;
      if (fill < 0.05) return;
    }

    // A single wide band that spells the brand name is a typographic logo, not an
    // emblem; the audit verifies colour, proportion and clear space differently.
    const isWordmark = rowBands <= 2 && (candidateAspect >= 2.2 || pageNamesBrand);

    const areaFraction = (boxW * boxH) / (pageW * pageH);
    let score = fill * Math.sqrt(areaFraction);
    if (preferEdges) {
      const cx = (x0 + boxW / 2) / pageW;
      const cy = (y0 + boxH / 2) / pageH;
      const edgeDistance = Math.min(cx, 1 - cx, cy, 1 - cy);
      // Marks live in the corners and edge bands; a person's torso in the middle
      // of a photo does not.
      score += Math.max(0, 0.3 - edgeDistance) * 1.6;
      if (cy < 0.34 || cy > 0.66) score *= 1.15;
    }

    ranked.push({ x: x0, y: y0, w: boxW, h: boxH, fill, score, rowBands, isWordmark });
  });

  if (!ranked.length) return null;
  // Highest score first: the top region is the default mark, and the rest are the
  // human-in-the-loop alternatives a reviewer can promote instead.
  ranked.sort((a, b) => b.score - a.score);

  // Builds the crop, colours, fingerprint and geometry for one region. Called once
  // per candidate so the gallery and the chosen spec are described identically.
  const buildCandidate = (best) => {
  const thumbScale = Math.min(1, maxDimension / Math.max(best.w, best.h));
  const cropW = Math.max(1, Math.round(best.w * thumbScale));
  const cropH = Math.max(1, Math.round(best.h * thumbScale));
  const crop = document.createElement('canvas');
  crop.width = cropW;
  crop.height = cropH;
  const cropCtx = crop.getContext('2d', { willReadFrequently: true });
  cropCtx.drawImage(canvas, best.x, best.y, best.w, best.h, 0, 0, cropW, cropH);

  let cropPixels;
  try {
    cropPixels = cropCtx.getImageData(0, 0, cropW, cropH).data;
  } catch {
    return null;
  }

  let referenceDataUrl = '';
  try {
    referenceDataUrl = crop.toDataURL('image/png');
  } catch {
    /* a blocked canvas has no thumbnail; the crop box still drives the checks */
  }

  // Foreground colours: everything that is not the page background.
  const buckets = new Map();
  for (let i = 0; i < cropW * cropH; i += 1) {
    const p = i * 4;
    if (cropPixels[p + 3] < 24) continue;
    const r = cropPixels[p];
    const g = cropPixels[p + 1];
    const b = cropPixels[p + 2];
    // Page mode skips the paper; a photo has no paper to skip, so every pixel of the
    // crop is evidence of the mark's colour.
    if (!flatGraphic && rgbDistance(r, g, b, bg.r, bg.g, bg.b) <= LOGO_BACKGROUND_TOLERANCE) continue;
    const key = `${Math.round(r / 24)},${Math.round(g / 24)},${Math.round(b / 24)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { r, g, b, count: 1 });
  }
  const logoColors = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((bucket) => hexOf(bucket.r, bucket.g, bucket.b));

  // 8x8 luminance fingerprint, normalised per crop so the same mark printed white
  // on black and black on white still compares as the same shape.
  const signature = [];
  for (let gy = 0; gy < 8; gy += 1) {
    for (let gx = 0; gx < 8; gx += 1) {
      let sum = 0;
      let count = 0;
      const yStart = Math.floor((gy * cropH) / 8);
      const yEnd = Math.max(yStart + 1, Math.floor(((gy + 1) * cropH) / 8));
      const xStart = Math.floor((gx * cropW) / 8);
      const xEnd = Math.max(xStart + 1, Math.floor(((gx + 1) * cropW) / 8));
      for (let y = yStart; y < Math.min(cropH, yEnd); y += 1) {
        for (let x = xStart; x < Math.min(cropW, xEnd); x += 1) {
          const p = (y * cropW + x) * 4;
          sum += luminanceOf(cropPixels[p], cropPixels[p + 1], cropPixels[p + 2]);
          count += 1;
        }
      }
      signature.push(sum / Math.max(1, count));
    }
  }
  const min = Math.min(...signature);
  const max = Math.max(...signature);
  const spread = max - min;
  const normalized = signature.map((value) =>
    spread < 0.01 ? 0.5 : Number(((value - min) / spread).toFixed(2))
  );

  return {
    referenceDataUrl,
    // 'wordmark' means the mark is the brand's name set in type (Adani, Sony, IBM,
    // Zara), so the audit measures colour, proportion and clear space rather than
    // comparing its outline against an emblem silhouette.
    logoType: best.isWordmark ? 'wordmark' : 'symbol-or-lockup',
    rowBands: best.rowBands,
    aspectRatio: Number((best.w / Math.max(1, best.h)).toFixed(2)),
    logoColors,
    spatialSignature: normalized,
    box: { x: best.x, y: best.y, w: best.w, h: best.h },
    pageWidth: pageW,
    pageHeight: pageH,
    inkRatio: Number(best.fill.toFixed(2))
  };
  };

  const spec = buildCandidate(ranked[0]);
  if (!spec) return null;
  // Up to five distinct regions with their own thumbnails. A deck whose biggest ink
  // cluster is a product photo still offers the wordmark as an alternative instead of
  // silently locking the wrong crop in.
  const candidateLogos = ranked.slice(0, 12).map(buildCandidate).filter(Boolean);
  return { ...spec, candidateLogos };
}

/** Mean absolute difference between two 8x8 fingerprints: 0 (same) to 1 (opposite). */
export function signatureDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

// ── 7. Vision engine ──────────────────────────────────────────────────────────
// One engine, one task: zero-shot CLIP classification with the fast, tested
// Xenova/clip-vit-base-patch32 (ViT-B/32). The captioning tiers (ViT-GPT2 and
// FLAN-T5) and the untested ViT-B/16 tier are gone, so no other repo can ever be
// fetched and nothing here runs at boot.
export const VISION_MODEL_OPTIONS = [
  {
    id: 'clip',
    name: 'Xenova / CLIP-ViT-B/32',
    badge: 'Fast Default · ~145 MB',
    repo: 'Xenova/clip-vit-base-patch32',
    task: 'zero-shot-image-classification',
    strengths:
      'Sub-second (<0.5s) zero-shot brand scene & domain alignment; works smoothly on any laptop CPU.',
    weaknesses:
      'Classifies the overall scene and brand vibe; it does not describe the layout.'
  }
];

function hasWebGpu() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Run the CLIP engine. Zero-shot classification only: it returns scene evidence,
 * never generated prose, so it cannot invent a subject that is not in the banner.
 * Returns `{ model, modelName, clip, hasWebGPU, durationSec }` and resolves with
 * `clip: null` rather than throwing when the model is unavailable.
 */
export async function runSelectedVisionModel(
  imageDataUrl,
  brandVault,
  onTelemetry = () => {}
) {
  const option = VISION_MODEL_OPTIONS[0];
  const modelId = CLIP_MODEL;
  const startedAt = performance.now();

  const emit = (payload) => {
    try {
      onTelemetry({ modelKey: option.id, modelName: option.name, hasWebGPU: hasWebGpu(), ...payload });
    } catch {
      /* a UI callback must not break the audit */
    }
  };

  const result = (clip) => ({
    model: option.id,
    modelName: option.name,
    clip: clip || null,
    hasWebGPU: hasWebGpu(),
    durationSec: Number(((performance.now() - startedAt) / 1000).toFixed(1))
  });

  emit({ phase: 'reasoning', step: 'Encoding visual patches & cross-verifying against Brand Vault…' });
  try {
    const clip = await analyzeBannerVisualSceneWithCLIP(
      imageDataUrl,
      brandVault,
      (percent) =>
        emit({
          phase: 'downloading',
          file: modelId,
          percent,
          elapsedSec: ((performance.now() - startedAt) / 1000).toFixed(1),
          etaSec: null
        }),
      modelId
    );
    if (!clip) {
      emit({ phase: 'reasoning', step: 'CLIP unavailable — continuing with palette, OCR and word checks…' });
    }
    return result(clip);
  } catch {
    return result(null);
  }
}
