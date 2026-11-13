import Fuse from 'fuse.js';
import Tesseract from 'tesseract.js';
import { REGULATORY_RULES, hasDisclaimerFinePrint } from './regulatoryRules';
import {
  repairOcrTextWithLLM,
  stripSuperlatives,
  checkSemanticClaimSimilarity,
  runSelectedVisionModel,
  extractLogoFromCanvas,
  signatureDistance
} from './localAiEngine';

// ── Competitor brand registry ─────────────────────────────────────────────────
// Sportswear, coffee and automotive decks share a visual language, so scene
// similarity cannot tell Nike from Adidas. The printed names can.
const KNOWN_BRANDS = [
  'nike', 'adidas', 'puma', 'reebok', 'under armour', 'new balance', 'asics',
  'starbucks', 'mcdonald', 'mcdonalds', 'burger king', 'kfc', 'subway', 'wendys',
  'dunkin', 'costa', 'tesla', 'ford', 'bmw', 'mercedes', 'audi', 'toyota', 'hyundai',
  'apple', 'samsung', 'sony', 'google', 'microsoft', 'amazon', 'coca-cola', 'pepsi',
  'red bull', 'adani', 'reliance', 'tata', 'zara', 'gucci', 'louis vuitton'
];

const BRAND_ALIASES = {
  adidas: ['adidas', 'three stripes', 'three-stripes'],
  'under armour': ['under armour', 'underarmour'],
  'burger king': ['burger king', 'burgerking'],
  'coca-cola': ['coca-cola', 'coca cola', 'coke'],
  'red bull': ['red bull', 'redbull'],
  mcdonalds: ['mcdonalds', "mcdonald's", 'mcdonald'],
  wendys: ["wendy's", 'wendys'],
  dunkin: ["dunkin'", 'dunkin donuts', 'dunkin']
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// OCR and filenames rarely agree on punctuation: compare on plain lowercase words.
const normalizeBrandText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const brandAliases = (brand) => BRAND_ALIASES[brand] || [brand];

const aliasPattern = (alias) => new RegExp(`\\b${escapeRegExp(normalizeBrandText(alias))}\\b`);

/** Which known brand is this vault for? Brand name first, then the file name. */
function targetBrandKey(brandVault) {
  const haystack = normalizeBrandText(
    `${brandVault?.brandName || ''} ${brandVault?.sourceName || ''}`
  );
  const known = KNOWN_BRANDS.find((brand) =>
    brandAliases(brand).some((alias) => aliasPattern(alias).test(haystack))
  );
  if (known) return known;
  return String(brandVault?.brandName || '').trim().toLowerCase() || 'the active brand';
}

/** The first competitor name printed anywhere on the creative, if any. */
function findRivalBrand(haystack, targetBrand) {
  const text = normalizeBrandText(haystack);
  if (!text) return null;
  const target = String(targetBrand || '').toLowerCase();
  const targetAliases = brandAliases(target);
  for (const brand of KNOWN_BRANDS) {
    if (brand === target) continue;
    // 'mcdonald' and 'mcdonalds' are one brand, not two.
    if (brandAliases(brand).some((alias) => targetAliases.includes(alias))) continue;
    const hit = brandAliases(brand).find((alias) => aliasPattern(alias).test(text));
    if (hit) return brand;
  }
  return null;
}

/**
 * Corner lockup OCR. A competitor wordmark is usually printed white-on-black in a
 * corner, and the full-frame pass drops it: the crop needs upscaling, contrast
 * normalisation and both polarities before the letters resolve.
 */
async function readCornerLockups(worker, img) {
  if (!worker || !img) return '';
  const zones = [
    { x: 0, y: 0 },
    { x: 0.72, y: 0 },
    { x: 0, y: 0.78 },
    { x: 0.72, y: 0.78 }
  ];
  const cropW = Math.max(64, Math.round(img.width * 0.28));
  const cropH = Math.max(48, Math.round(img.height * 0.22));
  const scale = 2.5;
  const found = [];
  for (const zone of zones) {
    const sx = Math.round(img.width * zone.x);
    const sy = Math.round(img.height * zone.y);
    const sw = Math.min(cropW, img.width - sx);
    const sh = Math.min(cropH, img.height - sy);
    if (sw < 24 || sh < 18) continue;
    for (const polarity of ['normal', 'inverted']) {
      const corner = document.createElement('canvas');
      corner.width = Math.round(sw * scale);
      corner.height = Math.round(sh * scale);
      const ctx = corner.getContext('2d');
      if (!ctx) continue;
      ctx.fillStyle = polarity === 'inverted' ? '#000000' : '#FFFFFF';
      ctx.fillRect(0, 0, corner.width, corner.height);
      try {
        ctx.filter =
          polarity === 'inverted'
            ? 'grayscale(1) contrast(2.2) invert(1)'
            : 'grayscale(1) contrast(2.2)';
      } catch {
        /* filter unsupported */
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, corner.width, corner.height);
      ctx.filter = 'none';
      try {
        const result = await worker.recognize(corner, {}, { text: true });
        const text = String(result?.data?.text || '').replace(/\s+/g, ' ').trim();
        if (text) found.push(text);
      } catch {
        /* corner pass is best effort */
      }
    }
  }
  return found.join(' ');
}

/**
 * Tesseract invents symbol noise from photographic texture ("yp = Jd 5 ON on",
 * "[+ a 8", "4 » J"). A line only counts as language when it reads like language:
 * enough real words, no punctuation soup, and mostly letters.
 */
export function isValidHumanSentence(str) {
  const text = String(str || '').replace(/\s+/g, ' ').trim();
  if (text.length < 12) return false;
  if (/[=»«[\]{}|\\<>~_^]/.test(text)) return false;

  const realWords = text.match(/\b[a-zA-Z]{3,}\b/g) || [];
  if (realWords.length < 3) return false;

  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  const nonSpace = text.replace(/\s/g, '').length;
  return nonSpace > 0 && letters / nonSpace >= 0.65;
}

const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'have', 'were', 'will', 'your', 'theirs', 'their',
  'when', 'what', 'they', 'them', 'than', 'then', 'into', 'over', 'also', 'been',
  'being', 'more', 'most', 'such', 'each', 'both', 'which', 'while', 'after',
  'before', 'about', 'because', 'between', 'during', 'without', 'these', 'those',
  'there', 'where', 'every', 'other', 'under', 'until', 'upon', 'across', 'plus'
]);

function meaningfulWords(text) {
  return new Set(
    (String(text || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter(
      (word) => !STOPWORDS.has(word)
    )
  );
}

// A contradiction is only credible when both sentences talk about the same thing.
function sharesMeaningfulWord(a, b) {
  const first = meaningfulWords(a);
  for (const word of meaningfulWords(b)) if (first.has(word)) return true;
  return false;
}

const QUANTITY_UNITS = new Set([
  'days', 'day', 'hours', 'hour', 'weeks', 'week', 'months', 'month', 'years', 'year',
  'miles', 'mile', 'km', 'oz', 'lb', 'lbs', 'g', 'kg', 'ml', 'liters', 'countries',
  'markets', 'stores', 'restaurants', 'users', 'customers', 'hospitals', 'tracks',
  'songs', 'people', 'employees', 'percent', 'stars', 'bit', 'businesses',
  'million', 'billion', 'thousand'
]);

// "5 days" or "150 hospitals" is a claim; a stray "4" out of a font size or a
// texture artifact is not.
function isMeaningfulQuantity(value, sentence) {
  const raw = String(value || '').trim();
  if (!/^\d{1,2}$/.test(raw)) return true;

  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const following = sentence.match(new RegExp(`(?:^|\\s)${escaped}\\s+([A-Za-z]{2,})`, 'i'));
  return Boolean(following && QUANTITY_UNITS.has(following[1].toLowerCase()));
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// HSL saturation of a colour: the difference between a brand hue and a grey. A
// calibration bar (#A0A0A0) and a white margin both read 0 here.
function hslSaturation({ r, g, b }) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  if (delta === 0) return 0;
  const lightness = (max + min) / 2;
  return delta / (1 - Math.abs(2 * lightness - 1));
}

function getLuminance({ r, g, b }) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

export function getContrastRatio(rgb1, rgb2) {
  const lum1 = getLuminance(rgb1);
  const lum2 = getLuminance(rgb2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return Number(((brightest + 0.05) / (darkest + 0.05)).toFixed(2));
}

// sRGB (D65) -> CIELAB. CIE76 ΔE is simply the Euclidean distance in this space.
function srgbToLinear(channel) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function rgbToLab({ r, g, b }) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);

  // sRGB -> CIE XYZ, normalised against the D65 white point
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

// True perceptual CIE76 ΔE in CIELAB space, not the Euclidean RGB distance it
// used to be. ΔE > 28 is a realistic "clearly a different brand colour" line.
export function getDeltaE(rgb1, rgb2) {
  const lab1 = rgbToLab(rgb1);
  const lab2 = rgbToLab(rgb2);
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Number(Math.sqrt(dL * dL + da * da + db * db).toFixed(1));
}

// Luminance straight from raw RGBA bytes, so tile scanning does not allocate an
// { r, g, b } object per pixel.
function luminanceFromBytes(r, g, b) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return lin(r) * 0.2126 + lin(g) * 0.7152 + lin(b) * 0.0722;
}

/**
 * Tile contrast fallback. OCR can only report the text it can read, which makes
 * the worst offenders — near-1:1 overlay text — exactly the ones it never sees.
 * This walks the canvas in small tiles and returns regions whose two tones are
 * far enough apart to be glyphs, yet too close for WCAG AA.
 */
export function scanLowContrastTiles(imgData, width, height, minRatio = 4.5) {
  const cols = 16;
  const tileW = Math.max(12, Math.ceil(width / cols));
  const tileH = tileW;
  const stride = Math.max(1, Math.round(Math.min(tileW, tileH) / 24));
  const regions = [];

  for (let y0 = 0; y0 < height; y0 += tileH) {
    for (let x0 = 0; x0 < width; x0 += tileW) {
      const x1 = Math.min(width, x0 + tileW);
      const y1 = Math.min(height, y0 + tileH);
      const samples = [];
      let maxJump = 0;
      for (let y = y0; y < y1; y += stride) {
        let previous = null;
        for (let x = x0; x < x1; x += stride) {
          const i = (y * width + x) * 4;
          const lum = luminanceFromBytes(imgData[i], imgData[i + 1], imgData[i + 2]);
          samples.push(lum);
          if (previous !== null && Math.abs(lum - previous) > maxJump) maxJump = Math.abs(lum - previous);
          previous = lum;
        }
      }
      if (samples.length < 16) continue;

      let minLum = 1;
      let maxLum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const lum = samples[i];
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }

      // Flat fills have no separation at all, photos/gradients have far too much,
      // and a smooth ramp has no sharp edge — the fallback only targets faint
      // glyphs sitting near their own background.
      const span = maxLum - minLum;
      if (span < 0.02 || span > 0.4) continue;
      if (maxJump < 0.08) continue;

      const mid = (minLum + maxLum) / 2;
      let darker = 0;
      for (let i = 0; i < samples.length; i += 1) if (samples[i] < mid) darker += 1;
      const inkFraction = darker / samples.length;
      if (inkFraction < 0.06 || inkFraction > 0.94) continue;

      const contrast = Number(((maxLum + 0.05) / (minLum + 0.05)).toFixed(2));
      if (contrast >= minRatio) continue;

      regions.push({ x0, y0, x1, y1, contrast });
    }
  }

  return regions;
}

// Comparative marketing language is the same unsubstantiated claim as "#1":
// "world's best selling" needs sourcing just as much as "100%".
const SUPERLATIVE_PATTERN = new RegExp(
  // "100%" sits outside the \b group: a boundary cannot follow "%", which is
  // why the percentage escaped detection for so long.
  String.raw`\b100\s*%|\b(?:number[- ]one|guaranteed|guarantees|zero[- ]downtime|zero[- ]risk|instant(?:ly)?|miracle|unlimited|best[- ]selling|unrivall?ed|unbeatable|top[- ]rated)\b|#\s*1\b|\bworld'?s\s+(?:best|leading|number one)\b|\b(?:the\s+)?best\s+(?:in|on)\s+(?:the\s+)?(?:world|market|industry)\b`,
  'i'
);

// Words a brand's own fact ledger uses that carry no identity signal. They are too
// common to prove an ad belongs to a brand, so they never count as a marker.
const IDENTITY_STOPWORDS = new Set([
  'about', 'after', 'also', 'been', 'before', 'being', 'between', 'brand', 'brands',
  'could', 'every', 'first', 'found', 'from', 'have', 'into', 'more', 'most', 'other',
  'over', 'shall', 'should', 'since', 'some', 'such', 'than', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'upon', 'very', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'within',
  'without', 'would', 'your', 'years', 'guideline', 'guidelines', 'branding'
]);

/**
 * The vocabulary that proves an ad belongs to this brand: its name, the words of
 * its name, and the distinctive nouns its own guidelines repeat ("coffee",
 * "espresso", "Angus"). A Nike headline has none of these.
 */
function brandIdentityMarkers(brandVault) {
  const markers = new Set();
  const add = (value) => {
    const term = String(value || '').toLowerCase().replace(/[’‘]/g, "'").trim();
    if (term.length >= 3) markers.add(term);
  };

  add(brandVault.brandName);
  String(brandVault.brandName || '')
    .split(/\s+/)
    .forEach(add);
  (brandVault.facts || []).forEach((fact) => {
    (String(fact.statement || '').toLowerCase().match(/\b[a-z][a-z'’-]{3,}\b/g) || []).forEach(
      (word) => {
        if (!IDENTITY_STOPWORDS.has(word)) add(word);
      }
    );
  });
  return markers;
}

// Brand archetypes and the vocabulary that proves a creative belongs to one. Nike's
// poster reads "YOU CAN'T WIN. SO WIN." with a swoosh and no wordmark in the OCR, so
// a literal string test called a perfectly on-brand poster cross-brand. Domain
// alignment verifies identity where the logo itself is the only wordmark.
const DOMAIN_PROFILES = [
  {
    id: 'sportswear',
    name: 'sportswear',
    brands: ['nike', 'adidas', 'puma', 'reebok', 'under armour', 'new balance', 'jordan', 'asics', 'lululemon'],
    keywords: /\b(win|won|winner|sport|athlete|athletic|run|running|training|game|play|victory|dream|fast|air|court|field|coach|champion)\b/gi
  },
  {
    id: 'coffee',
    name: 'coffee, café & QSR',
    brands: ['starbucks', 'mcdonald', 'burger king', 'kfc', 'dunkin', 'subway', 'taco bell', 'chipotle', 'costa', 'peet', 'domino'],
    keywords: /\b(coffee|espresso|latte|roast|cup|cafe|brew|siren|proudly serve|burger|beef|fries|meal|delicious|order|menu)\b/gi
  },
  {
    id: 'automotive',
    name: 'EV & automotive',
    brands: ['tesla', 'ford', 'toyota', 'honda', 'bmw', 'audi', 'mercedes', 'rivian', 'lucid', 'volkswagen', 'hyundai', 'kia', 'nissan', 'volvo', 'polestar', 'chevrolet', 'jeep'],
    keywords: /\b(suv|miles|range|epa|electric|charging|autopilot|drive|car|vehicles?|sedan|awd|mph)\b/gi
  }
];

function domainByBrand(brandName) {
  const name = String(brandName || '').toLowerCase();
  if (!name) return null;
  return DOMAIN_PROFILES.find((profile) => profile.brands.some((brand) => name.includes(brand))) || null;
}

function domainScore(profile, text) {
  const haystack = String(text || '');
  profile.keywords.lastIndex = 0;
  return (haystack.match(profile.keywords) || []).length;
}

// The industry an ad is actually speaking in: the profile with the strongest hit.
function detectDomain(text) {
  let best = null;
  let bestScore = 0;
  DOMAIN_PROFILES.forEach((profile) => {
    const score = domainScore(profile, text);
    if (score > bestScore) {
      best = profile;
      bestScore = score;
    }
  });
  return bestScore >= 1 ? best : null;
}

// A brand that ships its book without its name in the file still has a domain.
function detectVaultDomain(brandVault) {
  const byBrand = domainByBrand(brandVault?.brandName);
  if (byBrand) return byBrand;
  const corpus = [
    brandVault?.rawText,
    ...(brandVault?.facts || []).map((fact) => fact.statement)
  ]
    .filter(Boolean)
    .join(' ');
  return detectDomain(corpus);
}

// Another brand named outright in the creative is a cross-brand failure whatever
// the vocabulary looks like.
function findNamedRival(text, brandName) {
  const haystack = String(text || '').toLowerCase();
  const own = String(brandName || '').toLowerCase();
  for (const profile of DOMAIN_PROFILES) {
    for (const brand of profile.brands) {
      if (own.includes(brand)) continue;
      const pattern = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (pattern.test(haystack)) return brand;
    }
  }
  return '';
}

// A cross-brand creative is the failure a colour check cannot catch: the poster is
// beautifully made, but nothing on it belongs to the brand whose rules are loaded.
function auditBrandIdentity(text, brandVault, { label = 'Ad copy', verb = 'contains' } = {}) {
  const brandName = String(brandVault?.brandName || '').trim();
  // Normalised but not lowercased: the offender is quoted back as the designer
  // typed it ("YOU CAN'T WIN."), while matching still ignores case.
  const normalized = String(text || '')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const haystack = normalized.toLowerCase();
  if (!brandName || !haystack) return null;

  // 1. A literal identity marker (name, wordmark line, brand fact) wins outright.
  for (const marker of brandIdentityMarkers(brandVault)) {
    if (haystack.includes(marker)) return null;
  }

  const excerpt = normalized.slice(0, 80);
  const rival = findNamedRival(normalized, brandName);
  const vaultDomain = detectVaultDomain(brandVault);
  const adDomain = detectDomain(normalized);

  const base = {
    id: 'ISS-BRAND-1',
    ruleId: 'BRAND-IDENTITY',
    category: 'Cross-Brand / Domain Identity Mismatch',
    severity: 'High',
    offendingText: excerpt,
    citation: `${brandVault.sourceName}: Brand Identity & Lockup Requirements`,
    suggestedFix: `Show the ${brandName} wordmark or an approved ${brandName} brand line, and remove other brands' campaign language.`
  };

  // 2. A competitor named in the creative.
  if (rival) {
    return {
      ...base,
      explanation: `${label} ('${excerpt}') ${verb} zero ${brandName} identity markers and references a competitor outside the loaded ${brandName} brand vault.`
    };
  }

  // 3. Domain alignment. A logo-only poster still reads as its brand: "YOU CAN'T WIN."
  // is unambiguous athletic copy, even with no "NIKE" spelled out anywhere.
  if (vaultDomain && adDomain && vaultDomain.id === adDomain.id) return null;

  // 4. Genuine mismatch: the vocabulary belongs to a different industry.
  if (vaultDomain && adDomain) {
    return {
      ...base,
      explanation: `${label} ('${excerpt}') ${verb} zero ${brandName} identity markers, and its ${adDomain.name} vocabulary belongs to a different industry than the loaded ${vaultDomain.name} guidelines.`
    };
  }

  return {
    ...base,
    explanation: `${label} ('${excerpt}') ${verb} zero required ${brandName} brand identity markers or lockups.`
  };
}

// ── Governance score ───────────────────────────────────────────────────────────
// Six checkpoints run on every audit. A checkpoint with no unresolved finding counts
// as compliant, so the gauge reports real numbers ("Compliant · 5") instead of
// deriving compliance from an issue count.
export const GOVERNANCE_CHECKPOINTS = [
  {
    id: 'TERMS',
    label: 'Prohibited & Banned Terms',
    matches: (category) => /Terminology Violation|AI Slop/.test(category)
  },
  {
    id: 'FACTS',
    label: 'Fact & Quantitative Metric Substantiation',
    matches: (category) => /Contradictory Fact|Semantic Claim/.test(category)
  },
  {
    id: 'TONE',
    label: 'Superlative & Anti-Slop Tone',
    matches: (category) => /Unsupported Promotional Claim|Tone & Accessibility/.test(category)
  },
  {
    id: 'LEGAL',
    label: 'Legal & Regulatory Disclaimer',
    matches: (category) => /Missing Mandatory Legal Disclaimer/.test(category)
  },
  {
    id: 'PALETTE',
    label: 'Visual Brand Palette Consistency',
    matches: (category) => /Visual Brand Consistency/.test(category)
  },
  {
    id: 'ACCESSIBILITY',
    label: 'Banner WCAG 2.1 AA Contrast & Brand Identity',
    matches: (category) => /Accessibility \(WCAG|Cross-Brand|Brand Identity/.test(category)
  }
];

const SEVERITY_PENALTY = { High: 22, Medium: 12, Low: 6 };

/**
 * Weighted trust score. Each unresolved High issue costs 22 points, Medium 12, Low 6.
 * A logged human override restores half of that deduction but keeps a 5-point
 * governance-review floor until a manager signs off. Clamped to 5–100.
 */
export function computeGovernanceScore(issues = [], overrides = {}, { hasAudited = false } = {}) {
  const totalChecks = GOVERNANCE_CHECKPOINTS.length;
  if (!hasAudited) {
    return { score: 0, passedChecks: 0, totalChecks, unresolvedCount: 0, overriddenCount: 0 };
  }

  const normaliseCategory = (issue) => String(issue.category || '').replace(/^Image OCR:\s*/, '');
  const isOverridden = (issue) => Boolean(overrides?.[issue.id]);
  // A manager-approved exception has been signed off, so its penalty is gone. A
  // request that is still pending keeps the half-penalty review floor.
  const isApproved = (issue) => overrides?.[issue.id]?.status === 'approved';
  const unresolved = issues.filter((issue) => !isOverridden(issue));
  const overridden = issues.filter(isOverridden);

  let deduction = 0;
  unresolved.forEach((issue) => {
    deduction += SEVERITY_PENALTY[issue.severity] ?? SEVERITY_PENALTY.Medium;
  });
  overridden.forEach((issue) => {
    if (isApproved(issue)) return;
    const full = SEVERITY_PENALTY[issue.severity] ?? SEVERITY_PENALTY.Medium;
    deduction += Math.max(5, full / 2);
  });

  const score = Math.min(100, Math.max(5, Math.round(100 - deduction)));

  const failedCheckIds = new Set();
  unresolved.forEach((issue) => {
    const category = normaliseCategory(issue);
    const checkpoint = GOVERNANCE_CHECKPOINTS.find((entry) => entry.matches(category));
    if (checkpoint) failedCheckIds.add(checkpoint.id);
  });

  return {
    score,
    // An audit that ran always has something it verified, even when flags exist.
    passedChecks: Math.max(1, totalChecks - failedCheckIds.size),
    totalChecks,
    unresolvedCount: unresolved.length,
    overriddenCount: overridden.length
  };
}

function auditAdCopy(adText, brandVault, { label = 'Ad copy', verb = 'contains' } = {}) {
  const issues = [];
  if (!adText || !adText.trim()) return issues;

  // 1. Banned Terms & AI-Slop Check
  brandVault.bannedTerms.forEach((rule) => {
    if (!rule.term) return;
    // A term may itself start or end with punctuation ("% off"), so the word
    // boundaries are added only where a word character actually sits. Apostrophes
    // match either glyph: a guideline's "can't" has to catch an ad's "CAN’T".
    const escaped = rule.term
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/'/g, "['’]");
    const lead = /^[a-z0-9]/i.test(rule.term) ? '\\b' : '';
    const trail = /[a-z0-9]$/i.test(rule.term) ? '\\b' : '';
    const regex = new RegExp(`${lead}${escaped}${trail}`, 'gi');
    let match;
    while ((match = regex.exec(adText)) !== null) {
      issues.push({
        id: `ISS-T-${issues.length + 1}`,
        ruleId: rule.id,
        category: rule.id.startsWith('SLOP') ? 'AI Slop / Tone' : 'Terminology Violation',
        severity: 'Medium',
        offendingText: match[0],
        explanation: `${rule.reason}. Flagged term "${match[0]}".`,
        citation: rule.citation,
        suggestedFix: rule.replacement
      });
    }
  });

  // 2. Quantitative Fact & Promotional Claim Verification
  const sentences = adText.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const fuse = new Fuse(brandVault.facts, {
    keys: ['statement', 'keywords'],
    // 0.40 keeps a match to genuinely similar wording; 0.60 pulled in unrelated
    // facts and produced nonsense contradictions.
    threshold: 0.4,
    includeScore: true
  });

  sentences.forEach((sentence) => {
    // Skip "#1" style rankings: those are superlatives handled below, not quantities
    const adNumbers = sentence.match(/(?<!#)\b\d[\d,]*(?:\.\d+)?(?:\s*%|\+|\s*x|-bit)?\b/g);
    const hasSuperlative = SUPERLATIVE_PATTERN.test(sentence);

    const sentenceIsHuman = isValidHumanSentence(sentence);

    if (adNumbers && brandVault.facts.length > 0 && sentenceIsHuman) {
      const searchResults = fuse.search(sentence);
      // 0.40 similarity keeps fuzzy matches honest. When nothing is close enough,
      // fall back to the fact sharing the most meaningful nouns with the claim —
      // the same credibility test, without loosening the threshold.
      const comparableFact = (() => {
        const wanted = meaningfulWords(sentence);
        let best = null;
        let bestScore = 0;
        brandVault.facts.forEach((fact) => {
          let score = 0;
          meaningfulWords(fact.statement).forEach((word) => {
            if (wanted.has(word)) score += 1;
          });
          if (score > bestScore) {
            bestScore = score;
            best = fact;
          }
        });
        return best;
      })();
      // A weak Fuse hit that shares no real noun must not shadow a closer fact:
      // "...90,000 restaurants" fuzzily matched a beef sentence and lost the
      // restaurant fact that actually contradicted it.
      const fuseFact = searchResults.find((hit) =>
        sharesMeaningfulWord(sentence, hit.item.statement)
      )?.item;
      const bestFact = fuseFact || comparableFact;
      if (bestFact && sharesMeaningfulWord(sentence, bestFact.statement)) {
        // Strip thousands separators before comparing, so "40,000" and "40000"
        // are the same claim instead of two different ones.
        const normalized = (value) => value.replace(/[\s,]/g, '');
        const numberMatches = adNumbers.some((num) =>
          bestFact.numbers.some((fNum) => normalized(fNum) === normalized(num))
        );
        if (!numberMatches && bestFact.numbers.length > 0) {
          // Cite the ad figure that is comparable to this fact: in "500 miles ...
          // and a 15-year warranty" the 15 is what contradicts an 8-year warranty,
          // not the 500. Nearest-value matching also skips "#1" style superlatives.
          const toNumber = (value) => Number(String(value).replace(/[^\d.]/g, '')) || 0;
          const distanceToFact = (value) =>
            Math.min(...bestFact.numbers.map((fNum) => Math.abs(toNumber(value) - toNumber(fNum))));
          const wrongNum = adNumbers.reduce(
            (closest, candidate) => (distanceToFact(candidate) < distanceToFact(closest) ? candidate : closest),
            adNumbers[0]
          );
          const rightNum = bestFact.numbers.reduce(
            (closest, candidate) =>
              Math.abs(toNumber(candidate) - toNumber(wrongNum)) < Math.abs(toNumber(closest) - toNumber(wrongNum))
                ? candidate
                : closest,
            bestFact.numbers[0]
          );
          // A bare stray digit is OCR texture, not a claim; only flag it when it is
          // attached to a unit or noun phrase ("5 days", "150 hospitals").
          if (!isMeaningfulQuantity(wrongNum, sentence)) return;
          // Replace only the whole number: "250" must not rewrite the 250 inside
          // "12500", and the surrounding words and punctuation stay untouched.
          const escapedWrong = String(wrongNum).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const corrected = sentence.replace(
            new RegExp(`(?<!\\d)${escapedWrong}(?!\\d)`),
            rightNum
          );
          issues.push({
            id: `ISS-F-${issues.length + 1}`,
            ruleId: bestFact.id,
            category: 'Contradictory Fact / Claim',
            severity: 'High',
            offendingText: sentence,
            explanation: `Draft claims "${wrongNum}", contradicting the verified metric (${rightNum}) in your guidelines.`,
            citation: `${bestFact.citation}: "${bestFact.statement}"`,
            // Always a complete, immediately actionable sentence: the verified number
            // swapped in for the contradicted one.
            suggestedFix: corrected,
            source: 'copy'
          });
        }
      } else if (hasSuperlative && sentenceIsHuman) {
        issues.push({
          id: `ISS-C-${issues.length + 1}`,
          ruleId: 'CLAIM-UNVERIFIED',
          category: 'Unsupported Promotional Claim',
          severity: 'High',
          offendingText: sentence,
          explanation: 'Quantitative or superlative promotional claim has no backing in the uploaded Fact Ledger.',
          citation: `Unverified Claim Policy (${brandVault.sourceName})`,
          suggestedFix: stripSuperlatives(sentence)
        });
      }
    } else if (hasSuperlative && sentenceIsHuman) {
      issues.push({
        id: `ISS-S-${issues.length + 1}`,
        ruleId: 'CLAIM-ABSOLUTE',
        category: 'Unsupported Promotional Claim',
        severity: 'High',
        offendingText: sentence,
        explanation: 'Absolute/superlative promotional claim lacks substantiated evidence in brand guidelines.',
        citation: `FTC / Brand Substantiation Standard (${brandVault.sourceName})`,
        suggestedFix: stripSuperlatives(sentence)
      });
    }

    // 3. Aggressive ALL-CAPS Tone Check
    const shouting = sentence.match(/\b[A-Z]{5,}\b/g);
    if (shouting && shouting.length >= 2) {
      issues.push({
        id: `ISS-TONE-${issues.length + 1}`,
        ruleId: 'TONE-CAPS',
        category: 'Tone & Accessibility',
        severity: 'Low',
        offendingText: sentence,
        explanation: `Excessive ALL-CAPS (${shouting.join(', ')}) reads aggressively and hinders screen-reader accessibility.`,
        citation: 'Brand Voice & Readability Standard',
        suggestedFix: sentence.replace(/\b([A-Z])([A-Z]{4,})\b/g, (_, f, r) => f + r.toLowerCase())
      });
    }
  });

  const identityIssue = auditBrandIdentity(adText, brandVault, { label, verb });
  if (identityIssue) {
    issues.push({ ...identityIssue, id: `ISS-BRAND-${issues.length + 1}` });
  }

  return issues;
}

// A suggested fix that repeats the offending text is not a fix: it is the "NLP
// suggestion echo" that left a designer with a green box saying the same wrong
// words. Every issue that leaves this module carries wording that actually differs,
// or none at all (the card then asks a human for a replacement).
function ensureGenuineFix(issue) {
  const norm = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const fix = String(issue.suggestedFix || '').trim();
  const offending = String(issue.offendingText || '').trim();
  if (!offending) return issue;
  if (fix && norm(fix) !== norm(offending)) return issue;

  const stripped = stripSuperlatives(offending);
  if (stripped && norm(stripped) !== norm(offending)) {
    return { ...issue, suggestedFix: stripped };
  }
  return { ...issue, suggestedFix: '' };
}

/**
 * Regulated-claim disclosure check. A green claim, a weight claim or an APR claim
 * obliges a footnote; creative that carries none is a legal failure, not a tone
 * preference.
 */
export function auditRegulatoryDisclosures(primaryText, imageTextOrVault, brandVaultOrSource, maybeSource) {
  // (text, brandVault) remains valid for callers outside this module.
  const legacy = typeof imageTextOrVault === 'object' && imageTextOrVault !== null;
  const brandVault = legacy ? imageTextOrVault : brandVaultOrSource;
  const primarySource = legacy ? 'copy' : maybeSource || 'copy';

  // The same rule can fire on typed copy or on a claim baked into the raster. The
  // origin decides the repair: a footnote can be appended to copy, but not to pixels.
  const extraText = typeof imageTextOrVault === 'string' ? imageTextOrVault : '';
  const copyText = primarySource === 'image' ? '' : String(primaryText || '');
  const ocrText =
    primarySource === 'image' ? String(primaryText || '') || extraText : extraText;
  const haystack = `${copyText}\n${ocrText}`.trim();
  if (!haystack) return [];

  const rules = (brandVault?.regulatoryRules?.length
    ? brandVault.regulatoryRules
    : REGULATORY_RULES
  ).filter((rule) => rule && rule.trigger);
  const alreadyDisclosed = hasDisclaimerFinePrint(haystack);

  const issues = [];
  rules.forEach((rule) => {
    const pattern = (() => {
      try {
        return new RegExp(rule.trigger, 'i');
      } catch {
        return null;
      }
    })();
    if (!pattern) return;

    let triggerSource = null;
    let match = copyText.match(pattern);
    if (match) {
      triggerSource = 'copy';
    } else {
      match = ocrText.match(pattern);
      if (match) triggerSource = 'image';
    }
    if (!match) return;
    if (alreadyDisclosed) return;

    const trigger = String(match[0]).trim();
    issues.push({
      id: `ISS-REG-${issues.length + 1}`,
      ruleId: rule.id,
      category: 'Missing Mandatory Legal Disclaimer',
      severity: 'High',
      offendingText: trigger,
      explanation:
        `The creative makes a regulated "${rule.name}" claim ("${trigger}") but carries no required fine print. ` +
        `${rule.standard} requires the footnote below before this can ship.`,
      citation: rule.guidelineRequirement
        ? `${rule.citation} — also stated in ${brandVault.sourceName}: "${rule.guidelineRequirement}"`
        : rule.citation,
      suggestedFix: rule.requiredFinePrint,
      // 'copy' can be repaired with a footnote; 'image' cannot.
      source: triggerSource,
      actionType: triggerSource === 'image' ? 'edit-image' : 'append-disclaimer'
    });
  });

  return issues;
}

/**
 * Public entry point. `extraText` lets a banner's OCR text satisfy (or trigger) the
 * disclaimer rules while the draft copy is audited separately.
 */
export function auditAdText(adText, brandVault, options = {}) {
  const copy = String(adText || '');
  const extra = String(options.extraText || '');
  const issues = copy.trim() ? auditAdCopy(copy, brandVault, options) : [];
  if (`${copy}\n${extra}`.trim()) {
    issues.push(
      ...auditRegulatoryDisclosures(copy, extra, brandVault, options.textSource || 'copy')
    );
  }
  // Every text rule reports where its finding came from, so the UI can offer a
  // surgical rewrite for typed copy instead of sending the reviewer to Canva.
  const origin = options.textSource === 'image' ? 'image' : 'copy';
  return issues.map((issue) => ({ ...ensureGenuineFix(issue), source: issue.source || origin }));
}

/**
 * Async half of the audit: vector-space claim comparison against the fact ledger.
 * Kept separate so the deterministic checks stay synchronous and instant.
 */
export async function auditSemanticClaims(adText, brandVault) {
  const text = String(adText || '').trim();
  if (!text || !Array.isArray(brandVault?.facts) || !brandVault.facts.length) return [];
  try {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim().length > 8);
    const found = await checkSemanticClaimSimilarity(sentences, brandVault.facts);
    return found.map((item, index) => ({
      id: `ISS-SEM-${index + 1}`,
      // The semantic pass only ever reads typed copy, never pixels.
      source: 'copy',
      ...item
    }));
  } catch {
    return [];
  }
}

// Curly apostrophes/quotes and ®, & and decimal inches are ordinary brand copy; a
// word pattern that rejects them silently deleted "CAN’T" and "Starbucks®".
const OCR_WORD_PATTERN = /^[a-zA-Z0-9%$.,'’‘"“”&®-]{2,}$/;

const OCR_VOWELS = /[aeiouy]/i;

/**
 * Tesseract invents text out of foliage, window frames and gradient noise: the output
 * is symbol soup, or consonant runs with no vowel structure. Every rule and model
 * downstream reads this text, so debris is dropped here rather than explained later.
 * Numbers and short all-caps acronyms (BYD, SUV, 4K) survive.
 */
export function sanitizeOcrText(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const kept = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const chars = line.replace(/\s/g, '');
    if (chars.length < 3) continue;
    const alnum = (chars.match(/[A-Za-z0-9]/g) || []).length;
    // More than 30% symbols: address bars, dashed rules and tree texture all fail here.
    if (alnum / chars.length < 0.7) continue;
    if (!OCR_VOWELS.test(line)) continue;
    const words = line.split(' ');
    const readable = words.filter((word) => {
      if (/^\d[\d.,%:/-]*$/.test(word)) return true;
      // "4K", "5G", "3D": a digit with a one-letter unit is still a word.
      if (/^\d+[A-Za-z]{1,2}$/.test(word)) return true;
      const letters = word.replace(/[^A-Za-z]/g, '');
      if (letters.length < 2) return false;
      // Acronyms are real: BYD, SUV, EV, BMW.
      if (letters.length <= 4 && /^[A-Z]+$/.test(letters)) return true;
      if (!OCR_VOWELS.test(letters)) return false;
      return !/[bcdfghjklmnpqrstvwxz]{6,}/i.test(letters);
    });
    // A line that is mostly debris is debris, even if one word looks sane.
    if (readable.length / words.length < 0.6) continue;
    kept.push(readable.join(' '));
  }
  return kept.join('\n');
}

function cleanOcrWord(text) {
  return String(text || '')
    .trim()
    .replace(/^[^a-zA-Z0-9.]+/, '')
    .replace(/[^a-zA-Z0-9%$.,'’‘"“”&®-]+$/, '');
}

// Tesseract often emits the apostrophe of "CAN’T" as its own token, or splits the
// final T off after it. Re-joining them is the difference between reading CAN’T and
// silently dropping the word the poster turns on.
function joinApostropheWords(words) {
  const joined = [];
  for (const word of words) {
    const text = String(word.text || '').trim();
    const previous = joined[joined.length - 1];
    if (previous && /^['’‘`´]+$/.test(text) && /[A-Za-z]$/.test(previous.text)) {
      previous.text += text;
      continue;
    }
    if (previous && /['’‘`´]$/.test(previous.text) && /^[A-Za-z]$/.test(text)) {
      previous.text += text;
      continue;
    }
    joined.push({ ...word, text });
  }
  return joined;
}

// A poster headline is allowed to be short ("SO WIN.", "JUST DO IT."), so the
// banner gate asks only that the line reads as words rather than symbol soup.
function isAdBannerLine(text) {
  const line = String(text || '').trim();
  if (!/[a-zA-Z]{2,}/.test(line)) return false;
  const compact = line.replace(/\s+/g, '');
  if (compact.length < 2) return false;
  const alphanumeric = (compact.match(/[A-Za-z0-9]/g) || []).length;
  return alphanumeric / compact.length >= 0.55;
}

// Darkest pixel approximates the glyph, lightest its background: a single centre
// pixel lands between glyphs and reports false 1:1 failures.
function wordContrast(ctx, canvas, bbox) {
  const { x0, y0, x1, y1 } = bbox;
  const px0 = Math.max(0, Math.floor(x0));
  const py0 = Math.max(0, Math.floor(y0));
  const pw = Math.max(1, Math.min(canvas.width - px0, Math.ceil(x1 - x0)));
  const ph = Math.max(1, Math.min(canvas.height - py0, Math.ceil(y1 - y0)));
  const region = ctx.getImageData(px0, py0, pw, ph).data;

  let fgRgb = { r: 0, g: 0, b: 0 };
  let bgRgb = { r: 255, g: 255, b: 255 };
  let minLum = Infinity;
  let maxLum = -Infinity;
  for (let p = 0; p < region.length; p += 4) {
    const rgb = { r: region[p], g: region[p + 1], b: region[p + 2] };
    const lum = getLuminance(rgb);
    if (lum < minLum) {
      minLum = lum;
      fgRgb = rgb;
    }
    if (lum > maxLum) {
      maxLum = lum;
      bgRgb = rgb;
    }
  }
  return getContrastRatio(fgRgb, bgRgb);
}

// Brand books specify the backdrop as a "% black value", so the audit measures the
// ring of pixels around the mark rather than the mark itself.
function backgroundBlackValue(ctx, canvas, box) {
  const pad = Math.max(4, Math.round(Math.min(box.w, box.h) * 0.18));
  const x0 = Math.max(0, Math.floor(box.x - pad));
  const y0 = Math.max(0, Math.floor(box.y - pad));
  const x1 = Math.min(canvas.width, Math.ceil(box.x + box.w + pad));
  const y1 = Math.min(canvas.height, Math.ceil(box.y + box.h + pad));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 4 || height < 4) return null;

  let data;
  try {
    data = ctx.getImageData(x0, y0, width, height).data;
  } catch {
    return null;
  }

  const innerX = box.x - x0;
  const innerY = box.y - y0;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x >= innerX && x < innerX + box.w && y >= innerY && y < innerY + box.h) continue;
      const p = (y * width + x) * 4;
      sum += getLuminance({ r: data[p], g: data[p + 1], b: data[p + 2] });
      count += 1;
    }
  }
  if (!count) return null;
  return Math.round((1 - sum / count) * 100);
}

// A typographic brand has no emblem to crop: its logo *is* its name. OCR's word boxes
// are the reliable region — the box that spells the brand name is the wordmark, while
// the largest ink cluster on the banner is usually the headline.
function findWordmarkRegion(boundingBoxes, brandName) {
  const target = String(brandName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (target.length < 3 || !Array.isArray(boundingBoxes) || !boundingBoxes.length) return null;
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hits = boundingBoxes.filter((word) => {
    const text = normalize(word.text);
    if (!text) return false;
    return text === target || (target.length >= 4 && text.includes(target));
  });
  if (!hits.length) return null;

  // Fragments of one word ("ADA" + "NI") merge into a single mark.
  const merged = hits.reduce((acc, word) => {
    const height = Math.max(1, word.y1 - word.y0);
    const touching = (box) =>
      word.y0 < box.y1 + height * 0.4 &&
      box.y0 < word.y1 + height * 0.4 &&
      word.x0 < box.x1 + height * 1.6 &&
      box.x0 < word.x1 + height * 1.6;
    const host = acc.find(touching);
    if (host) {
      host.x0 = Math.min(host.x0, word.x0);
      host.y0 = Math.min(host.y0, word.y0);
      host.x1 = Math.max(host.x1, word.x1);
      host.y1 = Math.max(host.y1, word.y1);
      return acc;
    }
    acc.push({ x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1 });
    return acc;
  }, []);

  // The largest spelling of the name is the lockup; a caption mention is not.
  const best = merged.reduce((a, b) =>
    (b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a
  );
  const w = Math.max(1, best.x1 - best.x0);
  const h = Math.max(1, best.y1 - best.y0);
  if (h < 10 || w < 24) return null;
  return { x: best.x0, y: best.y0, w, h };
}

// OCR tells us where the name sits; pixels tell us what colour it is. The region's
// dominant colour is the plate the letters sit on, so everything else is letter ink.
function buildWordmarkRegion(canvas, box) {
  if (!canvas || !box) return null;
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(Math.round(box.w), canvas.width - x);
  const h = Math.min(Math.round(box.h), canvas.height - y);
  if (w < 8 || h < 8) return null;

  let data;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    data = ctx.getImageData(x, y, w, h).data;
  } catch {
    return null;
  }

  const toHex = (r, g, b) =>
    `#${[r, g, b]
      .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`;
  const keyOf = (i) => `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;

  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 24) continue;
    const key = keyOf(i);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let plateKey = null;
  let plateCount = -1;
  counts.forEach((count, key) => {
    if (count > plateCount) {
      plateCount = count;
      plateKey = key;
    }
  });

  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 24) continue;
    if (keyOf(i) === plateKey) continue;
    const r = Math.min(255, Math.round(data[i] / 24) * 24);
    const g = Math.min(255, Math.round(data[i + 1] / 24) * 24);
    const b = Math.min(255, Math.round(data[i + 2] / 24) * 24);
    const key = `${r},${g},${b}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { r, g, b, count: 1 });
  }

  const logoColors = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((bucket) => toHex(bucket.r, bucket.g, bucket.b));

  return {
    box: { x, y, w, h },
    aspectRatio: Number((w / h).toFixed(2)),
    logoColors,
    logoType: 'wordmark',
    isWordmark: true,
    source: 'ocr'
  };
}

export async function auditAdImage(imageSrc, brandVault, onProgress = () => {}, options = {}) {
  const onTelemetry = typeof options.onTelemetry === 'function' ? options.onTelemetry : () => {};
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      // OCR gets its own canvas. Glyphs sitting on a photo gradient or hard against
      // the crop edge lose their edge contrast, which is how "SUV" came back as
      // "SU" — the V had no clean background to define it. A 24px white border gives
      // every edge glyph a white neighbour, the upscale gives Tesseract more pixels
      // per stroke, and a moderate contrast lift separates type from texture. The
      // original-resolution canvas stays untouched so WCAG contrast and palette
      // sampling still measure the artwork as published.
      const OCR_PADDING = 24;
      const ocrScale = Math.max(1.5, Math.min(2.2, 1600 / Math.max(1, img.width)));
      const ocrCanvas = document.createElement('canvas');
      ocrCanvas.width = Math.round(img.width * ocrScale) + OCR_PADDING * 2;
      ocrCanvas.height = Math.round(img.height * ocrScale) + OCR_PADDING * 2;
      const ocrCtx = ocrCanvas.getContext('2d');
      ocrCtx.fillStyle = '#FFFFFF';
      ocrCtx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
      try {
        ocrCtx.filter = 'contrast(1.4) brightness(1.04)';
      } catch {
        /* filter unsupported — the padded upscale still helps */
      }
      ocrCtx.drawImage(img, OCR_PADDING, OCR_PADDING, img.width * ocrScale, img.height * ocrScale);
      ocrCtx.filter = 'none';

      // Tesseract reports boxes on the padded, upscaled canvas; bring them back into
      // image space (subtract the padding, divide by the scale) so the SVG overlay
      // lands on the word the reader sees.
      const toImageSpace = (box) => ({
        x0: (box.x0 - OCR_PADDING) / ocrScale,
        y0: (box.y0 - OCR_PADDING) / ocrScale,
        x1: (box.x1 - OCR_PADDING) / ocrScale,
        y1: (box.y1 - OCR_PADDING) / ocrScale
      });

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colorBuckets = {};
      const step = Math.max(4, Math.floor(imgData.length / 4 / 1500) * 4);

      for (let i = 0; i < imgData.length; i += step) {
        const r = Math.round(imgData[i] / 24) * 24;
        const g = Math.round(imgData[i + 1] / 24) * 24;
        const b = Math.round(imgData[i + 2] / 24) * 24;
        const key = `${r},${g},${b}`;
        colorBuckets[key] = (colorBuckets[key] || 0) + 1;
      }

      const topRgb = Object.entries(colorBuckets)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k]) => {
          const [r, g, b] = k.split(',').map(Number);
          return {
            r, g, b,
            hex: '#' + [r, g, b].map((x) => Math.min(255, x).toString(16).padStart(2, '0')).join('').toUpperCase()
          };
        });

      const visualIssues = [];

      // 1. Dominant Color vs Brand Hex Palette
      if (brandVault.colors.length > 0 && topRgb.length > 0) {
        const primarySample = topRgb[0];
        const nearest = brandVault.colors
          .map((bc) => ({ ...bc, deltaE: getDeltaE(primarySample, hexToRgb(bc.hex)) }))
          .sort((a, b) => a.deltaE - b.deltaE)[0];

        if (nearest.deltaE > 28) {
          visualIssues.push({
            id: 'VIS-CLR-1',
            ruleId: nearest.id,
            category: 'Visual Brand Consistency',
            severity: 'Medium',
            offendingText: `Banner Dominant Hex ${primarySample.hex}`,
            explanation: `Primary image color (${primarySample.hex}) sits ΔE₇₆=${nearest.deltaE} from the nearest approved palette color (${nearest.hex}) in CIELAB space, beyond the 28 perceptual tolerance.`,
            citation: nearest.source,
            suggestedFix: `Recolor banner background/accent to ${nearest.hex}`
          });
        }
      }

      // 1b. Signature chromatic palette. White and black are neutrals every poster
      // uses, so a #FFFFFF match proves nothing. A brand with a chromatic signature
      // colour (Starbucks green) needs at least one chromatic ad colour near it.
      const brandChromatic = brandVault.colors.filter(
        (color) =>
          !['#FFFFFF', '#000000'].includes(String(color.hex || '').toUpperCase()) &&
          hslSaturation(hexToRgb(color.hex)) >= 0.18
      );
      const adChromatic = topRgb.filter((color) => hslSaturation(color) >= 0.18);

      if (brandChromatic.length > 0 && adChromatic.length > 0) {
        const matches = adChromatic.map((sample) => {
          const nearest = brandChromatic
            .map((brandColor) => ({ ...brandColor, deltaE: getDeltaE(sample, hexToRgb(brandColor.hex)) }))
            .sort((a, b) => a.deltaE - b.deltaE)[0];
          return { sample, nearest };
        });
        const closest = [...matches].sort((a, b) => a.nearest.deltaE - b.nearest.deltaE)[0];
        const strictPalette = /no other colou?rs? may be substituted/i.test(brandVault.rawText || '');
        const hasPaletteMatch = matches.some((match) => match.nearest.deltaE <= 38);
        // A guideline that forbids substitution is absolute: one stray hue is a
        // violation even when another colour in the same banner does match.
        const strictViolation = strictPalette && matches.some((match) => match.nearest.deltaE > 40);
        const worst = [...matches].sort((a, b) => b.nearest.deltaE - a.nearest.deltaE)[0];
        const offender = !hasPaletteMatch ? closest : worst;
        // Suggest the brand's strongest hue rather than whichever palette row a
        // washed-out sample happened to pair with.
        const signature = [...brandChromatic]
          .sort((a, b) => hslSaturation(hexToRgb(b.hex)) - hslSaturation(hexToRgb(a.hex)))[0];

        if (!hasPaletteMatch || strictViolation) {
          visualIssues.push({
            id: 'VIS-PALETTE-1',
            ruleId: closest.nearest.id,
            category: 'Visual Brand Consistency',
            severity: 'High',
            offendingText: `Off-Brand Visual Palette — banner hue ${offender.sample.hex}`,
            explanation: hasPaletteMatch
              ? `Banner hue ${offender.sample.hex} sits ΔE₇₆=${offender.nearest.deltaE} from the nearest brand colour, ${offender.nearest.name} (${offender.nearest.hex}). The guidelines state no other colours may be substituted, so a hue this far outside the palette reads as another brand's campaign.`
              : `No chromatic colour in the banner is within ΔE₇₆=38 of the brand's signature palette. The closest is ${offender.sample.hex} at ΔE₇₆=${offender.nearest.deltaE} from ${offender.nearest.name} (${offender.nearest.hex}). These hues read as another brand's campaign.`,
            citation: `${brandVault.sourceName}: Signature Brand Palette`,
            suggestedFix: `Recolour the banner with the brand's chromatic palette (e.g. ${signature.hex})`
          });
        }
      }

      // 2. Tesseract.js OCR + per-line WCAG contrast audit
      let ocrText = '';
      let ocrWordCount = 0;
      let wcagFailCount = 0;
      let lowContrastRegions = [];
      const boundingBoxes = [];
      const failingLines = [];
      const contrastTarget = brandVault.minContrastRatio || 4.5;
      let ocrWorker = null;
      try {
        // tesseract.js v5+ moved word geometry under `blocks`, which is disabled by
        // default. Requesting it keeps boundingBoxes (and WCAG) populated.
        ocrWorker = await Tesseract.createWorker('eng', 1, {
          logger: (m) => {
            if (m.status === 'recognizing text') onProgress(Math.round(m.progress * 100));
          }
        });
        const result = await ocrWorker.recognize(ocrCanvas, {}, { blocks: true, text: true });
        const lines = (result.data.blocks || []).flatMap((block) =>
          (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || [])
        );

        const keptLines = [];
        for (const line of lines) {
          if (keptLines.length >= 12) break;

          // 55 clears the noise floor without dropping clean display type; short
          // headlines are kept by isAdBannerLine rather than by sentence length.
          const words = joinApostropheWords(line.words || [])
            .map((word) => ({ ...word, cleanText: cleanOcrWord(word.text) }))
            .filter((word) => word.confidence >= 55 && OCR_WORD_PATTERN.test(word.cleanText));
          if (!words.length) continue;

          const rawLineText = words.map((word) => word.cleanText).join(' ');
          const avgConfidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
          if (avgConfidence < 55) continue;
          if (!isAdBannerLine(rawLineText)) continue;

          // Edge-clipped words and OCR debris are repaired before the claim checks
          // run, so the audit reads the headline the designer actually wrote.
          const lineText = (await repairOcrTextWithLLM(rawLineText)) || rawLineText;
          const cleanLine = sanitizeOcrText(lineText).replace(/\n/g, ' ');
          if (!cleanLine || !isAdBannerLine(cleanLine)) continue;

          keptLines.push(cleanLine);
          ocrWordCount += words.length;

          const scored = words.map((word) => {
            const box = toImageSpace(word.bbox);
            const contrast = wordContrast(ctx, canvas, box);
            return { text: word.cleanText, contrast, failsContrast: contrast < contrastTarget, box };
          });

          scored.forEach((word) => {
            boundingBoxes.push({
              ...word.box,
              text: word.text,
              contrast: word.contrast,
              failsContrast: word.failsContrast
            });
          });

          const failing = scored.filter((word) => word.failsContrast);
          if (failing.length) {
            failingLines.push({
              text: lineText,
              failingText: failing.map((word) => word.text).join(' '),
              contrast: Number(
                (failing.reduce((sum, word) => sum + word.contrast, 0) / failing.length).toFixed(2)
              )
            });
          }
        }

        ocrText = keptLines.join('\n');
        // Corner lockups get their own pass: a small, high-contrast rival logo is
        // exactly what the full-frame OCR drops.
        const cornerText = sanitizeOcrText(await readCornerLockups(ocrWorker, img));
        if (cornerText) ocrText = `${ocrText}\n${cornerText}`.trim();

        // One card per text line, not per word: a low-contrast headline used to
        // produce a separate card for every word in it.
        failingLines.slice(0, 3).forEach((line) => {
          wcagFailCount += 1;
          visualIssues.push({
            id: `VIS-WCAG-${wcagFailCount}`,
            ruleId: 'WCAG-AA',
            category: 'Accessibility (WCAG 2.1)',
            severity: 'High',
            offendingText: `Flagged Banner Text: "${line.text}"`,
            explanation: `Average contrast across "${line.failingText}" is ${line.contrast}:1, below the ${contrastTarget}:1 WCAG AA minimum.`,
            citation: 'WCAG 2.1 AA Accessibility Standard',
            suggestedFix: 'Increase text overlay contrast above 4.5:1'
          });
        });
      } catch (err) {
        console.warn('OCR warning:', err);
      } finally {
        if (ocrWorker) {
          try {
            await ocrWorker.terminate();
          } catch {
            /* worker already released */
          }
        }
      }

      // 2b. Tile fallback: OCR is blind to near-1:1 text, so when it reads almost
      // nothing (or what it read has almost no separation) scan the pixels instead.
      const minRatio = brandVault.minContrastRatio || 4.5;
      const worstOcrContrast = boundingBoxes.reduce((min, box) => Math.min(min, box.contrast), Infinity);
      if (ocrWordCount < 2 || worstOcrContrast < 1.6) {
        lowContrastRegions = scanLowContrastTiles(imgData, canvas.width, canvas.height, minRatio);
        if (lowContrastRegions.length > 0 && wcagFailCount === 0) {
          const worstTile = lowContrastRegions.reduce((min, r) => Math.min(min, r.contrast), Infinity);
          visualIssues.push({
            id: 'VIS-WCAG-TILE-1',
            ruleId: 'WCAG-AA',
            category: 'Accessibility (WCAG 2.1)',
            severity: 'High',
            offendingText: `Low-contrast banner region (${lowContrastRegions.length} tile${lowContrastRegions.length > 1 ? 's' : ''})`,
            explanation: `OCR only resolved ${ocrWordCount} word(s) in this banner, and a tile scan found ${lowContrastRegions.length} region(s) whose text-to-background contrast tops out at ${worstTile}:1. Near-1:1 text is illegible to readers and invisible to OCR, so it is measured from pixels instead.`,
            citation: 'WCAG 2.1 AA Accessibility Standard',
            suggestedFix: 'Darken the overlay text or lighten its banner background until contrast exceeds 4.5:1'
          });
        }
      }

      // 3. Run Full Text Audit on Text Extracted from Inside the Banner Image
      const ocrIssues = auditAdText(ocrText, brandVault, {
        label: 'Ad creative and OCR text',
        verb: 'contain',
        // Everything this pass reads is pixels: a disclaimer here has to be baked
        // into the artwork, not typed into the draft.
        textSource: 'image'
      }).map((iss) => ({
        ...iss,
        id: `OCR-${iss.id}`,
        category: `Image OCR: ${iss.category}`,
        // Pixels, whatever the rule's default origin was: these findings are baked
        // into the artwork and only an image edit can repair them.
        source: 'image',
        explanation: `[Found in Banner Graphic] ${iss.explanation}`
      }));

      // 4. Neural vision. CLIP only loads here — on an uploaded banner — so a copy-only
      // audit never pays for a 90 MB model, and neither does app boot.
      let visionAnalysis;
      try {
        visionAnalysis = await runSelectedVisionModel(
          canvas.toDataURL('image/jpeg', 0.85),
          brandVault,
          onTelemetry
        );
      } catch {
        visionAnalysis = null;
      }
      const clipAnalysis = visionAnalysis?.clip || null;

      // 5. Let pixels settle the identity question the wordmark left open. A Nike
      // athlete poster over the Nike vault is on-brand even when OCR reads no brand
      // name; the same poster over a coffee vault is a scene mismatch no colour
      // distance can detect.
      if (clipAnalysis) {
        const dropIdentityIssues = () => {
          for (let i = ocrIssues.length - 1; i >= 0; i -= 1) {
            if (/Cross-Brand|Brand Identity/.test(ocrIssues[i].category)) ocrIssues.splice(i, 1);
          }
        };

        if (clipAnalysis.isVisualMatch) {
          dropIdentityIssues();
        } else if (clipAnalysis.brandSceneScore < 18) {
          // One finding, not two: the text-domain flag says the same thing with less
          // evidence, so it gives way to the vision card.
          dropIdentityIssues();
          const activeBrand = String(brandVault.brandName || '').trim();
          visualIssues.push({
            id: 'VIS-CLIP-1',
            ruleId: 'CLIP-SCENE',
            category: 'Vision AI: Scene & Identity Mismatch',
            severity: 'High',
            offendingText: `Visual Scene: ${clipAnalysis.topDetectedScene} (${clipAnalysis.topScore}%)`,
            explanation:
              `[CLIP ViT-B/32 Vision Encoder] Uploaded creative visually matches "${clipAnalysis.topDetectedScene}" ` +
              `(${clipAnalysis.topScore}% confidence) instead of the expected ${activeBrand || 'active brand'} visual identity ` +
              `(${clipAnalysis.brandSceneScore}% alignment).`,
            citation: `${brandVault.sourceName || 'Compiled Brand Vault'} (Multimodal CLIP ViT-B/32 Check)`,
            suggestedFix: `Replace banner graphic with on-brand ${activeBrand} product/identity imagery.`
          });
        }
        // 18–27% sits in the ambiguous band: the scene is not clearly on-brand, but it
        // is not clearly someone else's campaign either, so no card is raised.
      }

      // 5b. Competitor identity. CLIP can say "athletic"; only the printed name can
      // say which rival. Copy, corner lockups and OCR words are scanned against a brand
      // registry, and any match is a hard violation whatever the scene scored — but the
      // finding never repeats the guessed name back to the user.
      const targetBrand = targetBrandKey(brandVault);
      const detectedRival = findRivalBrand(`${options.adCopy || ''}\n${ocrText}`, targetBrand);
      if (detectedRival) {
        const targetLabel = targetBrand.toUpperCase();
        // One finding, not two: the generic scene card carries weaker evidence.
        for (let i = visualIssues.length - 1; i >= 0; i -= 1) {
          if (visualIssues[i].id === 'VIS-CLIP-1') visualIssues.splice(i, 1);
        }
        if (clipAnalysis) {
          clipAnalysis.isVisualMatch = false;
          clipAnalysis.brandSceneScore = 0;
          // Deliberately unnamed: a retailer's own name in the copy is not a competitor
          // mark, and printing a guess gave false positives. The finding says what was
          // seen, never which brand the engine thinks it was.
          clipAnalysis.overrideBadge = '⚠️ Vision AI: 0% Match — Off-Brand Identity Detected';
        }
        const citation = `${brandVault.sourceName || 'Brand Vault'}: Exclusive Brand Identity & Lockup Standard`;
        visualIssues.push({
          id: 'VIS-RIVAL-1',
          ruleId: 'BRAND-EXCLUSIVITY',
          category: 'Cross-Brand Competitor Violation',
          severity: 'High',
          offendingText: 'Competitor / Off-Brand Identity Detected',
          flaggedText: 'Competitor / Off-Brand Identity Detected',
          explanation: `Detected a competitor or off-brand identity inside a creative audited against ${targetLabel} guidelines.`,
          citation,
          ruleCitation: citation,
          suggestedFix: `Remove external branding and replace with official ${targetLabel} creative.`
        });
      }

      // 6. Logo governance. The mark cropped off the guidelines is compared with the
      // mark actually printed on the creative: shape, colour, backdrop value and clear
      // space, each tied to the rule the brand book states.
      const logoConditions = brandVault.logoConditions || null;
      // A manually uploaded mark has no canvas fingerprint or crop box, so it cannot
      // be compared shape-for-shape; it still counts as the declared lockup elsewhere.
      const logoReference =
        brandVault.logoSpec && brandVault.logoSpec.logoType !== 'manual-upload'
          ? brandVault.logoSpec
          : null;
      let logoRegion = null;
      if (logoReference || logoConditions) {
        try {
          // Two detectors, because a creative is either a flat page or a photograph.
          // The page-background mask reads a mark on white and returns nothing on a
          // photo (everything differs from the border), where the local-contrast mask
          // finds a white swoosh on an athlete and returns nothing on a blank page.
          logoRegion =
            extractLogoFromCanvas(canvas, '', { preferEdges: true, maxHeightRatio: 0.5 }) ||
            extractLogoFromCanvas(canvas, '', {
              preferEdges: true,
              flatGraphic: true,
              maxHeightRatio: 0.5
            });
        } catch {
          logoRegion = null;
        }
      }

      // 6a. Hybrid wordmark detection. When the brand's logo is its name in type, the
      // OCR box spelling that name is the logo region: colour, proportion, backdrop
      // value and clear space are then verified on the letters themselves.
      const wordmarkBox = findWordmarkRegion(boundingBoxes, brandVault.brandName);
      const wordmarkRegion = wordmarkBox ? buildWordmarkRegion(canvas, wordmarkBox) : null;
      if (wordmarkRegion && (!logoRegion || logoReference?.logoType === 'wordmark')) {
        logoRegion = wordmarkRegion;
      }

      if (logoRegion) {
        const brandRgb = (brandVault.colors || []).map((color) => hexToRgb(color.hex));
        const isApprovedLogoColour = (hex) =>
          ['#FFFFFF', '#000000'].includes(String(hex).toUpperCase()) ||
          brandRgb.some((rgb) => getDeltaE(hexToRgb(hex), rgb) <= 22);
        const adLogoColours = logoRegion.logoColors || [];
        const paletteMatch = adLogoColours.some(isApprovedLogoColour);
        // The mark's own chromatic signature: a white swoosh carries none of the
        // siren's green, which is what "0% of the brand colour" looks like in pixels.
        // Black and white are approved lockups, so they cannot be the discriminator.
        const signatureColours = (logoReference?.logoColors || [])
          .map((hex) => hexToRgb(hex))
          .filter((rgb) => hslSaturation(rgb) >= 0.18);
        const adChromaticColours = adLogoColours
          .map((hex) => hexToRgb(hex))
          .filter((rgb) => hslSaturation(rgb) >= 0.18);
        const carriesSignatureColour = signatureColours.length
          ? adChromaticColours.some((rgb) =>
              signatureColours.some((ref) => getDeltaE(rgb, ref) <= 25)
            )
          : paletteMatch;
        const activeBrand = String(brandVault.brandName || '').trim() || 'the active brand';
        let markFlagged = false;

        // A. A different graphic standing in for the logo: the wrong shape, and none
        // of the approved logo colours. A wide white swoosh is not a green siren.
        if (logoReference?.spatialSignature && logoConditions?.forbidRecolor && !logoRegion.isWordmark) {
          const referenceAspect = Number(logoReference.aspectRatio) || 1;
          const bannerAspect = Number(logoRegion.aspectRatio) || 1;
          const aspectShift =
            Math.abs(bannerAspect - referenceAspect) / Math.max(0.35, referenceAspect);
          const shapeDistance = signatureDistance(
            logoReference.spatialSignature,
            logoRegion.spatialSignature
          );
          if ((aspectShift > 0.75 || shapeDistance > 0.42) && !carriesSignatureColour) {
            markFlagged = true;
            visualIssues.push({
              id: 'VIS-LOGO-1',
              ruleId: 'LOGO-IDENTITY',
              category: 'Logo Governance: Missing or Unauthorized Brand Mark',
              severity: 'High',
              offendingText: `Banner mark ${bannerAspect}:1 — reference is ${referenceAspect}:1`,
              explanation:
                `The reference lockup in ${brandVault.sourceName} is ${referenceAspect}:1 and prints in ` +
                `${logoReference.logoColors.join(', ') || 'the approved palette'}. The banner's primary graphic is ` +
                `${bannerAspect}:1 (shape distance ${shapeDistance.toFixed(2)}) and carries none of those colours` +
                `${adLogoColours.length ? ` (${adLogoColours.join(', ')})` : ''}. A different mark is not a substitute for the ${activeBrand} logo.`,
              citation: 'Logo Usage Guidelines & Co-Branding Requirements (Page 1-5)',
              suggestedFix: `Replace the banner graphic with the official ${activeBrand} lockup supplied in the brand guidelines.`
            });
          }
        }

        // B. The right mark, painted in a colour the guidelines do not allow.
        if (!markFlagged && logoConditions?.forbidRecolor && adLogoColours.length) {
          const unauthorized = adLogoColours.filter((hex) => !isApprovedLogoColour(hex));
          if (unauthorized.length) {
            visualIssues.push({
              id: 'VIS-LOGO-2',
              ruleId: 'LOGO-COLOR',
              category: logoRegion.isWordmark
                ? 'Logo Improper Use: Unauthorized Wordmark Color'
                : 'Logo Improper Use: Unauthorized Logo Color Substitution',
              severity: 'High',
              offendingText: `Recoloured mark: ${unauthorized.join(', ')}`,
              explanation: `The mark's pixels read ${unauthorized.join(', ')}, outside the ${activeBrand} palette and outside the approved black and white lockups. The guidelines forbid changing the logo colour.`,
              citation: `${brandVault.sourceName}: Logo Colour Rules (Page 2 & Page 5 Rule #3)`,
              suggestedFix: `Repaint the mark in an approved logo colour (${(brandVault.colors || [])
                .slice(0, 3)
                .map((color) => color.hex)
                .join(', ') || 'brand palette'}).`
            });
          }
        }

        // C. The grayscale backdrop window: % black around the mark, not on it.
        const grayRule = logoConditions?.backgroundGrayscaleRule;
        if (grayRule?.deadZone) {
          const blackValue = backgroundBlackValue(ctx, canvas, logoRegion.box);
          if (
            blackValue !== null &&
            blackValue >= grayRule.deadZone[0] &&
            blackValue <= grayRule.deadZone[1]
          ) {
            visualIssues.push({
              id: 'VIS-LOGO-3',
              ruleId: 'LOGO-BACKGROUND',
              category: 'Logo Background Control Violation (Page 7)',
              severity: 'High',
              offendingText: `Backdrop ${blackValue}% black around the mark`,
              explanation: `The pixels around the mark measure ${blackValue}% black, inside the ${grayRule.deadZone[0]}%–${grayRule.deadZone[1]}% dead zone the guidelines exclude. Allowed backdrop values are ${grayRule.allowed.join(' or ')} after conversion to gray scale.`,
              citation: `${brandVault.sourceName}: Logo Background Values (Page 7)`,
              suggestedFix: `Set the backdrop below ${grayRule.deadZone[0]}% or above ${grayRule.deadZone[1]}% black.`
            });
          }
        }

        // D. Clear space: the frame the guidelines reserve around the mark.
        if (logoConditions?.requireClearSpace && logoRegion.box) {
          const box = logoRegion.box;
          const margin = Math.min(
            box.x,
            box.y,
            canvas.width - (box.x + box.w),
            canvas.height - (box.y + box.h)
          );
          const requiredMargin = Math.min(canvas.width, canvas.height) * 0.02;
          const overlappingText = boundingBoxes.find((word) => {
            // The wordmark's own glyphs sit inside the mark, not on top of it.
            if (
              word.x0 >= box.x - 2 &&
              word.y0 >= box.y - 2 &&
              word.x1 <= box.x + box.w + 2 &&
              word.y1 <= box.y + box.h + 2
            ) {
              return false;
            }
            const overlapX = Math.max(0, Math.min(box.x + box.w, word.x1) - Math.max(box.x, word.x0));
            const overlapY = Math.max(0, Math.min(box.y + box.h, word.y1) - Math.max(box.y, word.y0));
            const area = Math.max(1, (word.x1 - word.x0) * (word.y1 - word.y0));
            return (overlapX * overlapY) / area > 0.25;
          });
          if (margin < requiredMargin || overlappingText) {
            visualIssues.push({
              id: 'VIS-LOGO-4',
              ruleId: 'LOGO-CLEAR-SPACE',
              category: 'Logo Clear Space / Overlap Advisory',
              severity: 'Medium',
              offendingText: overlappingText
                ? `Mark overlaps "${overlappingText.text}"`
                : `Mark sits ${Math.round(margin)}px from the edge`,
              explanation: overlappingText
                ? `The mark overlaps the banner text "${overlappingText.text}", which the logo guidelines forbid.`
                : `The mark sits ${Math.round(margin)}px from the edge of the creative, inside the 2% frame (${Math.round(requiredMargin)}px) the guidelines reserve as clear space.`,
              citation: `${brandVault.sourceName}: Clear Space (Page 3) & Improper Use (Page 5 Rule #6)`,
              suggestedFix:
                'Increase the empty margin around the mark (or move the text) until the clear-space frame is intact.'
            });
          }
        }

        // E. Typographic proportion. A wordmark is a letterform drawing: stretching or
        // condensing it changes the logo, which no guideline permits.
        if (logoRegion.isWordmark && Number(logoReference?.aspectRatio) > 0) {
          const referenceAspect = Number(logoReference.aspectRatio);
          const bannerAspect = Number(logoRegion.aspectRatio) || 1;
          const stretch =
            Math.abs(bannerAspect - referenceAspect) / Math.max(0.2, referenceAspect);
          if (stretch > 0.3) {
            visualIssues.push({
              id: 'VIS-LOGO-5',
              ruleId: 'LOGO-STRETCH',
              category: 'Logo Improper Use: Stretched or Condensed Wordmark',
              severity: 'High',
              offendingText: `Wordmark ${bannerAspect}:1 — reference is ${referenceAspect}:1`,
              explanation:
                `The wordmark on the banner measures ${bannerAspect}:1 against ${referenceAspect}:1 in ` +
                `${brandVault.sourceName}, a ${Math.round(stretch * 100)}% distortion. A typographic logo is ` +
                'scaled uniformly; stretching or condensing it is improper use.',
              citation: `${brandVault.sourceName}: Logo Proportion${
                logoConditions?.forbidStretch ? ' & Distortion Rules' : ''
              }`,
              suggestedFix:
                'Rescale the wordmark uniformly from the master artwork — never stretch or condense it.'
            });
          }
        }
      }

      resolve({
        dominantColors: topRgb,
        ocrText,
        boundingBoxes,
        lowContrastRegions,
        clipAnalysis,
        visionAnalysis,
        issues: [...visualIssues, ...ocrIssues]
      });
    };
    // A broken URL used to leave the audit promise pending forever; resolve with an
    // explicit empty report instead.
    img.onerror = () =>
      resolve({
        dominantColors: [],
        ocrText: '',
        boundingBoxes: [],
        lowContrastRegions: [],
        clipAnalysis: null,
        issues: [],
        error: 'Banner image could not be decoded'
      });
    img.src = imageSrc;
  });
}