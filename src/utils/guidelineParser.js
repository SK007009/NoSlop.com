import nlp from 'compromise';
// Legacy build: the modern one calls Uint8Array.prototype.toHex, which only exists
// in Chromium 140+. Older browsers throw "hashOriginal.toHex is not a function" on
// every PDF, so the legacy bundle (which ships its own polyfills) is required.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract from 'tesseract.js';
import { collectRegulatoryRules } from './regulatoryRules';
import { extractLogoFromCanvas, repairOcrTextWithLLM } from './localAiEngine';

// Configure PDF.js worker using Vite's local bundler with CDN fallback
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
} catch {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/legacy/build/pdf.worker.min.mjs`;
}

// A 40-page brand book only needs its text layer read. Rendering every page is
// what froze the tab, so canvas and OCR work is limited to a curated handful of
// pages: the ones that print colour specs, plus the scanned ones with no text layer.
const MAX_TEXT_PAGES = 40;
const MAX_VISUAL_PAGES = 40;
const MAX_OCR_PAGES = 40;
const PDF_RENDER_SCALE = 1.5;
// A stylised ad page is often a small-print poster: at 1.5× Tesseract drops thin
// glyphs, so OCR pages render at 3× and are flattened to high-contrast grayscale
// before recognition.
const OCR_RENDER_SCALE = 3.0;
// A 3× render of a full-bleed poster is 30 MP and freezes the tab before OCR even
// starts. Slides keep the full 3×; only genuinely huge pages are clamped.
const OCR_MAX_PIXELS = 12000000;
// A page carrying fewer selectable characters than this is a slide, a colour chart
// or a scan: its content only exists as pixels, so it must be OCR'd. Nike's deck
// says "PURPOSE…" on page 1 and nothing else in its text layer, which used to leave
// every page after it — palette chart and Don'ts included — completely unread.
const SPARSE_PAGE_TEXT = 120;
// Text items sitting within this many PDF units share a baseline
const LINE_JUMP = 3;
const MAX_SAMPLED_COLORS = 12;
// A deck's own written values are the palette; sampled artwork only fills the gaps,
// and only up to this many entries. Near-identical samples (three purples off one
// gradient) collapse into the first one.
const MAX_EXPLICIT_COLORS = 6;
const PALETTE_DUPLICATE_DELTA_E = 25;
const COLOR_HINT_PATTERN = /\b(colou?rs?|palette|swatches?|hex|rgba?|primary)\b/i;
// A numeric claim is a metric with a unit, a percentage or a price — never a bare
// number like "4747" that merely happens to sit on the poster.
const METRIC_TRIGGER =
  /(?:\b\d+(?:\.\d+)?\s*%|\$\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:kg|gb|tb|hz|khz|mhz|ghz|inch(?:es)?|hours?|days?|miles?|lbs?|oz|ml|litres?|liters?|kw|kwh|mpg|users?|hospitals?|countries|stars?|million|billion)\b)/i;
const MAX_CANVAS_EDGE = 2600;

// A ledger entry is only worth keeping when the OCR did not mangle it. More than a
// handful of characters a clean sentence never contains, or one of the known broken
// tokens, and the "fact" is noise the audit would later quote back at the user.
const FACT_ARTIFACT_BUDGET = 5;
const OCR_GIBBERISH_PATTERN = /\b(?:1s|Athird|ith)\b/;

function isValidMetricFact(sentence) {
  const text = String(sentence || '').trim();
  if (text.length < 4) return false;
  if (OCR_GIBBERISH_PATTERN.test(text)) return false;
  const artifacts = (text.match(/[^a-zA-Z0-9\s.,%$-]/g) || []).length;
  if (artifacts > FACT_ARTIFACT_BUDGET) return false;
  return METRIC_TRIGGER.test(text);
}

function channelHex(value) {
  return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0');
}

function rgbToHex(r, g, b) {
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`.toUpperCase();
}

// HSL saturation/lightness of a raw RGB triple. Used to tell a printed brand hue
// apart from a neutral grey calibration bar or the page's own white margin.
function hslOf(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { s: 0, l: lightness };
  return {
    s: delta / (1 - Math.abs(2 * lightness - 1)),
    l: lightness
  };
}

// CIE76 ΔE between two #RRGGBB values. Two swatches closer than 25 are the same
// colour to a reader, even when their hex digits differ.
function hexToLab(hex) {
  const clean = String(hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const channel = (index) => {
    const value = (parseInt(full.slice(index, index + 2), 16) || 0) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };

  const R = channel(0);
  const G = channel(2);
  const B = channel(4);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function hexDeltaE(hexA, hexB) {
  const a = hexToLab(hexA);
  const b = hexToLab(hexB);
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

// Readable swatch names, so a sampled palette is not four rows of "Custom Color"
function describeHex(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2 / 255;

  if (max - min < 18) {
    if (lightness > 0.72) return 'Soft Neutral';
    if (lightness > 0.4) return 'Stone Grey';
    return 'Charcoal';
  }

  const delta = max - min;
  let hue;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;

  const family =
    hue < 15 || hue >= 345
      ? 'Red'
      : hue < 45
        ? 'Amber'
        : hue < 70
          ? 'Lime'
          : hue < 165
            ? 'Green'
            : hue < 195
              ? 'Teal'
              : hue < 255
                ? 'Blue'
                : hue < 300
                  ? 'Violet'
                  : 'Magenta';
  const tone = lightness > 0.72 ? 'Light' : lightness > 0.42 ? 'Mid' : 'Deep';
  return `${tone} ${family}`;
}

/**
 * Rebuild line breaks from PDF.js text items. A content stream is a flat run of
 * fragments with absolute coordinates, so joining them with spaces turns a
 * bulleted brand book into one run-on paragraph — and every rule then shares a
 * line with the next one. A jump in the Y coordinate is a new line.
 */
function itemsToPageText(items) {
  let text = '';
  let lastY = null;

  items.forEach((item) => {
    const str = typeof item.str === 'string' ? item.str : '';
    const y = Array.isArray(item.transform) ? item.transform[5] : null;

    if (lastY !== null && y !== null && Math.abs(y - lastY) > LINE_JUMP) {
      text += '\n';
    } else if (text && str && !/\s$/.test(text) && !/^\s/.test(str)) {
      text += ' ';
    }

    text += str;

    if (item.hasEOL) {
      text += '\n';
      lastY = null;
    } else if (y !== null) {
      lastY = y;
    }
  });

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = src;
  });
}

// A caller may pass a shared worker so a multi-page scan loads the WASM engine and
// language data once. A throwaway worker (no shared worker) is still terminated.
async function runOcr(source, sharedWorker = null) {
  let worker = sharedWorker;
  try {
    if (!worker) worker = await Tesseract.createWorker('eng');
    // Block geometry carries per-line confidence, which is the only way to tell a
    // real caption from photo-collage noise like "aud -7 EEE s".
    let timer = null;
    const result = await Promise.race([
      worker.recognize(source, {}, { blocks: true, text: true }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('OCR page timed out')), OCR_PAGE_TIMEOUT_MS);
      })
    ]);
    clearTimeout(timer);
    const data = result?.data || {};
    const blocks = data.blocks || [];
    const lines = blocks.flatMap((block) =>
      (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || [])
    );

    if (!lines.length) {
      return (data.text || '')
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => isValidHumanSentence(line) || isKnownOcrHeading(line))
        .join('\n')
        .trim();
    }

    // Rebuild each line from words that are both confident and word-shaped, then
    // keep the line only when it averages 65+ confidence and reads as language.
    return lines
      .map((line) =>
        joinApostropheWords(line.words || [])
          .map((word) => ({ text: cleanOcrWord(word.text), confidence: word.confidence }))
          .filter((word) => word.confidence >= OCR_MIN_WORD_CONFIDENCE && OCR_WORD_PATTERN.test(word.text))
      )
      .filter((words) => words.length > 0)
      .map((words) => ({
        text: words.map((word) => word.text).join(' '),
        confidence: words.reduce((sum, word) => sum + word.confidence, 0) / words.length
      }))
      .filter((line) => line.confidence >= OCR_MIN_WORD_CONFIDENCE)
      .filter((line) => !OCR_ARTIFACT_PATTERN.test(line.text))
      .filter((line) => !OCR_NOISE_TOKENS.test(line.text) && !SINGLE_LETTER_RUN.test(line.text))
      .filter((line) => isValidHumanSentence(line.text) || isKnownOcrHeading(line.text))
      .map((line) => line.text)
      .join('\n')
      .trim();
  } catch (err) {
    console.warn('Guideline OCR warning:', err);
    return '';
  } finally {
    if (worker && !sharedWorker) {
      try {
        await worker.terminate();
      } catch {
        /* worker already released */
      }
    }
  }
}

/**
 * Dominant brand colours straight off a rendered canvas. Transparent pixels and
 * near-white / near-black page backgrounds are skipped — a deck is mostly page
 * and margin, so counting those would drown the actual brand accents.
 */
export function extractColorsFromCanvas(
  canvas,
  maxColors = 4,
  sourceLabel = 'Visual Asset Sampling',
  includeNeutrals = false
) {
  if (!canvas || !canvas.width || !canvas.height) return [];

  let ctx;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    return [];
  }
  if (!ctx) return [];

  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch (err) {
    // Tainted canvas (remote asset without CORS headers) — caller keeps going
    console.warn('Canvas colour sampling blocked:', err);
    return [];
  }

  const buckets = new Map();
  // Only the central safe zone is brand artwork. A viewer badge in the corner, a
  // header rule or a page number is not a colour decision — and on a deck that is
  // otherwise black, white and grey, that lone purple marker became the "palette".
  const left = Math.floor(canvas.width * 0.12);
  const right = Math.floor(canvas.width * 0.85);
  const top = Math.floor(canvas.height * 0.12);
  const bottom = Math.floor(canvas.height * 0.88);
  let sampled = 0;
  // Monochrome brands are the norm, not an edge case: a Nike or Adidas spread is
  // black type, white page and a grey ramp. Those pixels used to be discarded, which
  // left the vault with nothing and forced the generic blue/green fallback palette.
  const neutralCounts = { black: 0, white: 0, offWhite: 0, grey: 0 };

  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const i = (y * canvas.width + x) * 4;
      sampled += 1;
      if (pixels[i + 3] < 8) continue;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      // Page white, print black and every achromatic calibration bar are neutral:
      // sampling them used to push a grey #E0E0E0/#A0A0A0/#B0B0B0 ramp into the
      // palette and bury the brand's actual green.
      const { s, l } = hslOf(r, g, b);
      if (s < 0.15) {
        if (l < 0.2) neutralCounts.black += 1;
        else if (l > 0.97) neutralCounts.white += 1;
        else if (l > 0.88) neutralCounts.offWhite += 1;
        else neutralCounts.grey += 1;
        continue;
      }
      if (l > 0.88 || l < 0.12) continue;

      const qr = Math.min(255, Math.round(r / 16) * 16);
      const qg = Math.min(255, Math.round(g / 16) * 16);
      const qb = Math.min(255, Math.round(b / 16) * 16);
      const key = `${qr},${qg},${qb}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.count += 1;
      else buckets.set(key, { r: qr, g: qg, b: qb, count: 1 });
    }
  }

  const accepted = [];
  const minimumCount = Math.max(1, sampled * 0.015);
  [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .forEach((bucket) => {
      if (accepted.length >= maxColors) return;
      // A tiny annotation badge never covers 1.5% of the page.
      if (bucket.count < minimumCount) return;
      const hex = rgbToHex(bucket.r, bucket.g, bucket.b);
      // Lavender #D090FF / #C090F0 / #D090F0 are one colour to a reader.
      if (accepted.some((existing) => hexDeltaE(hex, existing.hex) < 28)) return;
      accepted.push({ ...bucket, hex });
    });

  const neutrals = includeNeutrals
    ? [
        { hex: '#111111', name: 'Black', count: neutralCounts.black },
        { hex: '#FFFFFF', name: 'White', count: neutralCounts.white },
        { hex: '#F5F5F5', name: 'Off-White', count: neutralCounts.offWhite },
        { hex: '#7E7E7E', name: 'Grey', count: neutralCounts.grey }
      ].filter((entry) => entry.count >= minimumCount)
    : [];

  // Accent hues first, then the neutrals that make a monochrome identity legible.
  return [
    ...accepted.map((bucket) => ({ hex: bucket.hex, name: describeHex(bucket.hex) })),
    ...neutrals
  ]
    .slice(0, Math.max(maxColors, 6))
    .map((entry, idx) => ({
      id: `CLR-V${idx + 1}`,
      name: entry.name,
      hex: entry.hex,
      source: sourceLabel
    }));
}

// "Black #000000" / "Primary 1A1A1A" on a colour chart: a six-digit value printed
// beside a colour word is a swatch even when OCR ate the hash mark.
function extractBareHexSwatches(pageText, sourceLabel) {
  const found = [];
  String(pageText || '')
    .split(/\r?\n/)
    .forEach((line) => {
      if (!COLOR_HINT_PATTERN.test(line)) return;
      for (const match of line.matchAll(/\b([0-9A-Fa-f]{6})\b/g)) {
        const hex = `#${match[1]}`.toUpperCase();
        if (hex === '#000000') continue;
        found.push({
          id: `CLR-H${found.length + 1}`,
          name: swatchNameFromText(pageText, hex) || describeHex(hex),
          hex,
          source: `${sourceLabel} (Printed Hex)`
        });
      }
    });
  return found;
}

export async function extractTextFromPDF(file, onProgress = () => {}) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const textPageCount = Math.min(pdf.numPages, MAX_TEXT_PAGES);
  const parsedPages = [];
  const pageTexts = new Map();

  // Pass 1 — text layer only, and cheap. A 40-page book costs one getTextContent
  // call per page instead of a full canvas render plus an OCR pass for each.
  for (let i = 1; i <= textPageCount; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = itemsToPageText(content.items);
    parsedPages.push({ number: i, text });
    pageTexts.set(i, text);
    onProgress(
      Math.round((i / textPageCount) * 45),
      `Reading text layer — page ${i} of ${textPageCount}…`
    );
  }

  // Pass 2 — nearly every page is rendered now. A brand book prints its palette
  // chart and its Don'ts as slide graphics while page 1's "PURPOSE" is real text,
  // so choosing render pages from the text layer alone skipped exactly the pages
  // that carry the colours and the negative rules. Pages 1–10, every colour/hex page
  // and every text-free page are rendered; OCR then runs on any page with fewer than
  // 120 characters of selectable text.
  const colorPages = parsedPages
    .filter((page) => COLOR_HINT_PATTERN.test(page.text))
    .map((page) => page.number)
    .slice(0, MAX_VISUAL_PAGES);
  const textFreePages = parsedPages
    .filter((page) => page.text.replace(/\s+/g, '').length < SPARSE_PAGE_TEXT)
    .map((page) => page.number)
    .slice(0, MAX_OCR_PAGES);

  const visualPages = new Set([
    ...parsedPages.slice(0, 10).map((page) => page.number),
    ...colorPages
  ]);
  const ocrPages = new Set(textFreePages);

  const visualColors = [];
  const seenHex = new Set();
  const pagesToRender = [...new Set([...visualPages, ...ocrPages])].sort((a, b) => a - b);

  // One worker for the whole document: createWorker loads the WASM engine and the
  // English model (seconds of work), so a worker per page made an 8-page scan feel
  // like a hang.
  // The reference mark comes off the identity spread: page 1–3, or whichever page a
  // deck titles "Logo Usage" / "Clear Space". A titled page outranks the cover.
  let logoSpec = null;
  let logoPriority = 0;

  let ocrWorker = null;
  const getOcrWorker = async () => {
    if (!ocrWorker) ocrWorker = await Tesseract.createWorker('eng');
    return ocrWorker;
  };

  try {
    for (let index = 0; index < pagesToRender.length; index += 1) {
      const pageNumber = pagesToRender[index];
      const isVisual = visualPages.has(pageNumber);
      const needsOcr = ocrPages.has(pageNumber);
      const work = isVisual && needsOcr ? 'palette + OCR' : isVisual ? 'palette sampling' : 'scanned page OCR';

      onProgress(
        45 + Math.round((index / Math.max(1, pagesToRender.length)) * 50),
        `Rendering page ${pageNumber} of ${pdf.numPages} — ${work}…`
      );

      const page = await pdf.getPage(pageNumber);
      // Fresh canvas per page: reusing one would paint page 2 over page 1's artwork
      // and sample a blend of both.
      const baseViewport = page.getViewport({ scale: 1 });
      const desiredScale = needsOcr ? Math.max(PDF_RENDER_SCALE, OCR_RENDER_SCALE) : PDF_RENDER_SCALE;
      const desiredPixels =
        baseViewport.width * baseViewport.height * desiredScale * desiredScale;
      const renderScale =
        desiredPixels > OCR_MAX_PIXELS
          ? desiredScale * Math.sqrt(OCR_MAX_PIXELS / desiredPixels)
          : desiredScale;
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const pageLabel = pageTexts.get(pageNumber) || '';
      const logoTitled =
        /\b(logo|swoosh|symbol|wordmark|brand mark|emblem|lockup|clear space|siren)\b/i.test(
          pageLabel
        );
      const logoPriorityHere = logoTitled ? 2 : pageNumber <= 3 ? 1 : 0;
      if (logoPriorityHere > logoPriority) {
        const candidate = extractLogoFromCanvas(canvas, pageLabel);
        if (candidate) {
          logoSpec = { ...candidate, page: pageNumber };
          logoPriority = logoPriorityHere;
        }
      }

      // Every rendered page is sampled, and neutrals count: a monochrome deck's
      // palette is black, white and grey and those exist only in the artwork. Printed
      // six-digit values on the same page join them.
      extractColorsFromCanvas(
        canvas,
        4,
        `${file.name} (Page ${pageNumber} Palette)`,
        true
      ).forEach((color) => {
        if (seenHex.has(color.hex) || visualColors.length >= MAX_SAMPLED_COLORS) return;
        seenHex.add(color.hex);
        visualColors.push(color);
      });
      extractBareHexSwatches(pageLabel, `${file.name} (Page ${pageNumber})`).forEach((color) => {
        if (seenHex.has(color.hex) || visualColors.length >= MAX_SAMPLED_COLORS) return;
        seenHex.add(color.hex);
        visualColors.push(color);
      });

      if (needsOcr) {
        onProgress(
          45 + Math.round(((index + 0.5) / Math.max(1, pagesToRender.length)) * 50),
          `Running OCR on scanned PDF page ${pageNumber} of ${pdf.numPages}...`
        );
        // One unreadable page must never stall the whole ingestion: every step below
        // is bounded, and a failure simply leaves that page's text layer as-is.
        try {
        // High-contrast grayscale: stylised ad type and dark gradient plates are what
        // make Tesseract drop fine print. The filter is applied while the page is
        // drawn into a second canvas — repainting a 10 MP bitmap through ctx.filter is
        // pathologically slow, while filtering vector draws costs almost nothing. The
        // palette and logo above were sampled from the true-colour canvas.
        const ocrCanvas = document.createElement('canvas');
        ocrCanvas.width = canvas.width;
        ocrCanvas.height = canvas.height;
        const ocrCtx = ocrCanvas.getContext('2d', { willReadFrequently: true });
        ocrCtx.fillStyle = '#FFFFFF';
        ocrCtx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
        try {
          ocrCtx.filter = 'grayscale(100%) contrast(150%)';
        } catch {
          /* filter unsupported — OCR still gets the 3× bitmap */
        }
        await Promise.race([
          page.render({ canvas: ocrCanvas, canvasContext: ocrCtx, viewport }).promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('OCR page render timed out')), 30000)
          )
        ]);
        ocrCtx.filter = 'none';

        const rawOcr = await runOcr(ocrCanvas, await getOcrWorker());
        ocrCanvas.width = 0;
        ocrCanvas.height = 0;
        if (rawOcr) {
          // Stylised fonts come back as "This beauty 1s also" or "O% APR". Every line
          // with real characters is repaired by the on-device LLM before facts,
          // metrics and banned terms are parsed out of it.
          const repairedLines = [];
          // A cold FLAN-T5 download must not hold the whole ingestion open: every
          // line gets the deterministic repair, and the model handles as many as fit
          // inside this per-page budget.
          const repairDeadline = performance.now() + 20000;
          for (const line of rawOcr.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || !/[A-Za-z0-9]/.test(trimmed)) continue;
            const fixed = await repairOcrTextWithLLM(trimmed, {
              allowModel: performance.now() < repairDeadline
            });
            repairedLines.push(String(fixed || trimmed).trim());
          }
          if (repairedLines.length) {
            pageTexts.set(
              pageNumber,
              `${pageTexts.get(pageNumber) || ''} ${repairedLines.join('\n')}`.trim()
            );
          }
        }
        } catch (err) {
          console.warn('Page OCR skipped:', err);
        }
      }

      // Release the bitmap before the next page renders
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    if (ocrWorker) {
      try {
        await ocrWorker.terminate();
      } catch {
        /* worker already released */
      }
    }
  }

  const fullText = parsedPages
    .map((page) => `[Page ${page.number}] ${pageTexts.get(page.number) || ''}`.trim())
    .join('\n\n');

  onProgress(100, `Parsed ${parsedPages.length} of ${pdf.numPages} pages`);
  return {
    text: fullText.trim(),
    visualColors,
    logoSpec,
    candidateLogos: logoSpec?.candidateLogos || []
  };
}

export async function extractGuidelinesFromImage(file, onProgress = () => {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    onProgress(15, 'Rendering guideline image onto canvas…');

    const naturalWidth = img.naturalWidth || img.width;
    const naturalHeight = img.naturalHeight || img.height;
    // Keep a huge poster inside canvas limits; colour sampling is scale-invariant
    const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    onProgress(40, 'Sampling dominant brand swatches…');
    const visualColors = extractColorsFromCanvas(
      canvas,
      4,
      `${file.name} (Visual Swatch Extraction)`
    );

    const logoSpec = extractLogoFromCanvas(canvas, '');

    onProgress(60, 'Reading printed brand rules with OCR…');
    const text = await runOcr(canvas);

    onProgress(100, 'Image ingestion complete');
    return { text, visualColors, logoSpec, candidateLogos: logoSpec?.candidateLogos || [] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Real brand books print a swatch name next to the value — "#E82127 (Tesla Red)" or
// "Cavendish Yellow: #FFE01B". Falling back to "Brand Palette 3" is fine, but a
// reviewer should see the book's own name when it gave one.
function swatchNameFromText(rawText, hex) {
  const bare = hex.replace('#', '');
  const after = new RegExp(String.raw`#${bare}\b\s*[(（]\s*([^)）]{2,28})\s*[)）]`, 'i').exec(rawText);
  if (after) return after[1].trim();

  const before = new RegExp(String.raw`([A-Za-z][A-Za-z0-9 '&.-]{2,28})\s*[:=—–-]\s*#${bare}\b`, 'i').exec(rawText);
  if (before) {
    const label = before[1].replace(/^(?:official|primary|core|brand|the|our)\s+/i, '').trim();
    if (label) return label;
  }
  return '';
}

/**
 * Written colour values: #HEX, rgb()/rgba(), and the "R: 232 G: 33 B: 39" form
 * older corporate PDFs still use. RGB triples are converted to hex so the palette
 * has one comparable representation.
 */
function extractColorSwatches(rawText, sourceName) {
  const swatches = [];
  const seen = new Set();

  const push = (hex, source) => {
    const value = String(hex || '').toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(value) || seen.has(value)) return;
    seen.add(value);
    swatches.push({
      hex: value,
      name: swatchNameFromText(rawText, value),
      source
    });
  };

  for (const match of rawText.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const digits = match[1];
    push(
      `#${digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits}`,
      `${sourceName} (Auto-mined Hex)`
    );
  }

  for (const match of rawText.matchAll(
    /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[,/)]/gi
  )) {
    push(rgbToHex(Number(match[1]), Number(match[2]), Number(match[3])), `${sourceName} (Auto-mined RGB)`);
  }

  // Printed swatch tables read "R0 G112 B74". OCR turns the zero of RO into the
  // letter O and the B of B74 into an 8, so both are repaired before the maths:
  // "RO G112 874" is still #00704A.
  const channelValue = (token) => Number(String(token).replace(/[OoQ]/g, '0')) || 0;
  // Printed swatch tables drop the '#': a standalone six-character code under an
  // HTML/HEX column (00704A, 000000) is still a brand colour. A code with no digit
  // is far more likely a word ("COFFEE"), so those are not promoted.
  for (const match of rawText.matchAll(/(?:^|[\s|(])([0-9A-Fa-f]{6})(?=$|[\s|),])/gm)) {
    const token = match[1];
    if (!/\d/.test(token) || /^[A-Z][a-z]/.test(token)) continue;
    push(`#${token}`, `${sourceName} (HTML Hex Table)`);
  }

  for (const match of rawText.matchAll(
    /\bR\s*[:=]?\s*([0-9OoQ]{1,3})\b[^\w%]{0,3}\bG\s*[:=]?\s*([0-9OoQ]{1,3})\b[^\w%]{0,3}\b(?:B|8)\s*[:=]?\s*(\d{1,3})\b/g
  )) {
    push(
      rgbToHex(channelValue(match[1]), channelValue(match[2]), channelValue(match[3])),
      `${sourceName} (Auto-mined RGB)`
    );
  }

  return swatches;
}

// "Avoid using the word hack" captures "the word hack"; strip the scaffolding so
// the rule matches the word a writer would actually type.
function tidyTerm(raw) {
  return String(raw || '')
    .replace(/^[\s"'“”]+|[\s"'“”]+$/g, '')
    .replace(/^(?:the\s+)?(?:words?|terms?|phrases?|language)\s+(?:like\s+|such as\s+)?/i, '')
    .replace(/[\s,.;:]+$/g, '')
    .trim()
    .toLowerCase();
}

const EMPTY_TERMS = /^(?:the|a|an|it|this|that|these|those|words?|terms?|phrases?)$/;
const MAX_FACTS = 200;

const NEGATIVE_SECTION_HEADING = /^(?:negative keywords?|words? to avoid|banned terms?|prohibited terms?|don['’]?ts?|never use|off-brand terms?|avoid these|what not to say)\b[^\w]*$/i;
const POSITIVE_SECTION_HEADING = /^(?:positive keywords?|words? to use|approved terms?|do['’]?s)\b/i;
const COLOR_SECTION_HEADING = /^(?:brand colou?rs?|accent colou?rs?|primary colou?rs?|secondary colou?rs?|colou?r palette|palette|light theme|dark theme|text colou?r|background(?: colou?r)?)\b/i;
const FONT_SECTION_HEADING = /^(?:brand fonts?|fonts?|typefaces?|typography|headings?|subheadings?|body(?: copy| text)?)\b/i;
const LOGO_SECTION_HEADING = /^(?:logo|wordmark|lockup)\b/i;
const GENERIC_SECTION_WORD = /(?:keywords?|colou?rs?|fonts?|typography|logo|wordmark|mission|purpose|vision|values|description|overview|guidelines?|rules?|tone|voice|do|don['’]?ts?|avoid|banned|prohibited|negative|positive)/i;
// Rule sections that live in bullets rather than sentences. A label like "Logo
// Improper Use" says nothing on its own; every item underneath it is the rule.
const RESTRICTION_SECTION_HEADING = /(discounting guidelines|prohibited from being used in|logo improper use|co-branding requirements)/i;
// When a deck forbids discounting, these are the hooks an ad can actually trip.
const DISCOUNT_TRIGGER_TERMS = ['discount', '% off', 'percent-off', 'cents-off', 'free', 'complimentary', 'BOGO', 'coupon', 'bundle'];
const LAYOUT_SPEC_PATTERN = /smaller than|larger than|clear space|minimum size|wordmark|siren symbol|pantone|cmyk|uncoated stock| coated hue|black value|gray scale|ink density|registration marks/i;
const PROSE_SECTION_HEADINGS = [
  [/^mission\b/i, 'mission'],
  [/^purpose\b/i, 'purpose'],
  [/^vision\b/i, 'vision'],
  [/^values\b/i, 'values'],
  [/^(?:description|about(?: us)?|overview|who we are)\b/i, 'description']
];

const HEXISH_TOKEN = /\b([0-9A-Fa-fIO]{6})\b/g;
const OCR_ARTIFACT_PATTERN = /[<>/\\|=+*^~¥€£§®©™[\]{}()]/;
const FACT_ARTIFACT_PATTERN = /[<>/\\|=*^~¥[\]{}]/;
const SINGLE_LETTER_RUN = /(?:\b[A-Za-z]\b[\s,.;:-]*){3,}/;
const OCR_NOISE_TOKENS = /\b(?:ry|es|aud|eee|sw|prio|pw|hs)\b/i;
const OCR_MIN_WORD_CONFIDENCE = 65;
// A photo collage can take Tesseract far longer than a text page; never let one
// pathological page hold the whole ingestion open.
const OCR_PAGE_TIMEOUT_MS = 20000;

// A heading is structure, not content: it changes how the lines beneath it read.
function detectSectionHeading(line, current) {
  const text = line.trim();
  if (!text) return null;

  const words = text.split(/\s+/).filter(Boolean);
  // "wordmark." is a sentence fragment from mid-paragraph, not a heading. Without
  // the punctuation guard it ended the rule section and swallowed the bullets.
  const isShort = text.length <= 48 && words.length <= 6 && !/[.,;]$/.test(text);
  const isAllCaps = isShort && !/[a-z]/.test(text) && /[A-Z]{3}/.test(text);

  // "HTML / HEX / R G B" and "Color Print Specifications" head swatch tables even
  // when OCR merges the header with the first row into a long line.
  if (/^(?:html|hex|rgb|colou?r)\b/i.test(text) && text.length <= 70) return 'colors';

  if (isShort) {
    if (NEGATIVE_SECTION_HEADING.test(text)) return 'negative';
    if (POSITIVE_SECTION_HEADING.test(text)) return 'positive';
    if (COLOR_SECTION_HEADING.test(text)) return 'colors';
    if (FONT_SECTION_HEADING.test(text)) return 'fonts';
    if (LOGO_SECTION_HEADING.test(text)) return 'logo';
    for (const [pattern, role] of PROSE_SECTION_HEADINGS) {
      if (pattern.test(text)) return role;
    }
  }

  // Inside a keyword list an ALL-CAPS entry is usually a keyword itself ("SECOND
  // HAND SHOES"), so only a recognised heading may end that block.
  const inKeywordBlock = current === 'negative' || current === 'positive';
  if (isAllCaps && !inKeywordBlock && GENERIC_SECTION_WORD.test(text)) return 'neutral';
  return null;
}

// Palette rows in real decks lose their "#", and OCR reads 1 as I and 0 as O:
// "DICOCE" is D1C0CE, "DICA81" is D1CA81.
function collectSectionColors(line, sink, sourceName) {
  if (!line) return;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length > 8) return;

  for (const match of line.matchAll(HEXISH_TOKEN)) {
    const raw = match[1];
    const normalized = raw.replace(/[Ii]/g, '1').replace(/[Oo]/g, '0').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(normalized)) continue;

    // A standalone row in a colour section is a swatch even without digits
    // ("FEFEFE" is white); prose tokens only qualify when they carry digits.
    const looksLikeSwatch =
      line.trim() === raw ||
      /\d/.test(normalized) ||
      /colou?r|background|hex|white|black|palette|primary|accent|text/i.test(line);
    if (!looksLikeSwatch) continue;

    const label = line
      .replace(raw, ' ')
      .replace(/[#:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const usableLabel =
      label && label.split(' ').length <= 3 && !/\d/.test(label) && /[a-z]/i.test(label);
    const hex = `#${normalized}`;

    sink.push({
      hex,
      name: usableLabel ? label : describeHex(hex),
      source: `${sourceName} (Colour Section Row)`
    });
  }
}

function isPlausibleKeyword(term) {
  if (!term) return false;
  if (term.length < 2 || term.length > 40) return false;
  if (!/[a-z]/i.test(term)) return false;
  if (OCR_ARTIFACT_PATTERN.test(term)) return false;
  return term.split(/\s+/).length <= 5;
}

// "NIKE Positive Keywords Negative Keywords" is a run of OCR'd headings, not a claim.
function isSectionVocabularyLine(line) {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length > 8) return false;
  const matches = line.match(/\b(?:keywords?|colou?rs?|fonts?|typography|logo|wordmark|mission|purpose|vision|values|description|overview|guidelines?|rules?|tone|voice|negative|positive)\b/gi) || [];
  return matches.length >= 2;
}

function hasFactArtifacts(line) {
  // "40,000+" and "1/3" are claims, not corruption
  return FACT_ARTIFACT_PATTERN.test(
    line.replace(/(\d)\s*\+/g, '$1').replace(/\d+\s*\/\s*\d+/g, ' ')
  );
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

// Curly apostrophes and quotes come straight out of Tesseract/PDF text, and brand
// copy is full of ®, & and decimal inches (".5\""): none of those may drop a word.
const OCR_WORD_PATTERN = /^[a-zA-Z0-9%$.,'’‘"“”&®-]{2,}$/;

function cleanOcrWord(text) {
  return String(text || '')
    .trim()
    .replace(/^[^a-zA-Z0-9.]+/, '')
    .replace(/[^a-zA-Z0-9%$.,'’‘"“”&®-]+$/, '');
}

// Tesseract often emits the apostrophe of "CAN’T" as its own token, or splits the
// final T off after it. Re-joining keeps the word whole instead of dropping it.
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

// Structure that legitimately falls below sentence length: section headings,
// hex rows and 2-3 word keyword entries.
function isKnownOcrHeading(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (/^#?[0-9A-Fa-fIO]{6}$/.test(text)) return true;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;
  const allCaps = !/[a-z]/.test(text) && /[A-Z]{2}/.test(text);
  // A short row only counts as a heading when every token is a real capitalised
  // word: photo texture yields pairs like "yp Jd", which used to slip through here.
  const keywordRow =
    words.length <= 3 && words.every((word) => /^[A-Z][A-Za-z'’-]{2,}$/.test(word));
  return allCaps || keywordRow;
}

// Brand names are almost always the first non-generic word of the file name:
// "starbucks brand guidelines.pdf" -> Starbucks, "Nike_Guidelines_2026.pdf" -> Nike.
const BRAND_NAME_NOISE = /^(?:the|brand|brands|guidelines?|standards?|communications?|content|style|guide|books?|identity|visual|partner|partners|copy|final|logo|pdf|doc|docx|2026|20\d\d)$/i;

function inferBrandName(rawText, sourceName = '') {
  const base = String(sourceName || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_+]+/g, ' ');
  const words = base
    .split(/[^A-Za-z0-9&'’.-]+/)
    .filter((word) => word && !BRAND_NAME_NOISE.test(word) && !/^\d/.test(word));
  if (words.length) {
    return words[0].replace(/^[-.]+|[-.]+$/g, '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  const firstLine = (String(rawText || '').split('\n').find((line) => line.trim().length > 3) || '')
    .replace(/\[Page \d+\]/, '')
    .trim();
  const capitalised = firstLine.split(/\s+/).find((word) => /^[A-Z][a-z]{2,}/.test(word));
  return capitalised ? capitalised.replace(/[^A-Za-z'’-]/g, '') : '';
}

/**
 * Logo usage conditions are written as prose across several spreads ("Do not
 * stretch…", "Clear space…", "Do not use any other colour…"), so each rule is read
 * on its own: a deck that bans stretching often says nothing about clear space, and
 * both still belong in the compiled lockup card.
 */
export function parseLogoConditions(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const forbidStretch =
    /don['’]?t stretch|do not stretch|don['’]?t distort|do not distort|condense|alter (?:our|the) logo|manipulate|proportion/i.test(
      text
    );
  const forbidRecolor =
    /do not change our logo colou?r|no other colou?rs? may be substituted|correct colou?rs?|do not use any other|logo colou?r/i.test(
      text
    );
  const forbidAngle = /do not angle|always use it vertically|do not rotate|never rotate|tilt the logo/i.test(text);

  // A window, not a sentence: "Clear space. The minimum clear space is 2X the height
  // of the mark" is two sentences, and stopping at the first full stop lost the 2X.
  const clearSpaceIndex = text.search(/clear space/i);
  const clearSpaceWindow = clearSpaceIndex >= 0 ? text.slice(clearSpaceIndex, clearSpaceIndex + 160) : '';
  const requireClearSpace = clearSpaceIndex >= 0 || /frames the logo/i.test(text);
  const multiplierMatch =
    clearSpaceWindow.match(/(\d+(?:\.\d+)?)\s*[xX]\b/) || clearSpaceWindow.match(/(\d{1,3})\s*%/);
  const clearSpaceMultiplier = multiplierMatch
    ? multiplierMatch[0].replace(/\s+/g, '').toUpperCase()
    : null;

  // ".5\" (13mm)" contains a full stop, so a [^.] run could never capture a minimum
  // size rule written in inches. Match to a clause boundary, then drop the "and no
  // larger than" half that often shares the sentence.
  const sizeMatch =
    text.match(/(?:no|not)\s+smaller\s+than\s+[^;]{3,70}/i) ||
    text.match(/minimum\s+(?:size|width|height)[^;]{0,70}/i) ||
    text.match(/no\s+taller\s+than\s+[^;]{3,70}/i);
  const minSizeRule = sizeMatch
    ? sizeMatch[0]
        .replace(/\s+and\s+no\s+(?:larger|taller|bigger)\s+than[\s\S]*$/i, '')
        .trim()
    : null;

  // "Between 0% and 60% after conversion to gray scale" is a *window*, and the gap
  // between two windows (60–80%) is the dead zone a mark disappears into.
  const grayText = [...text.matchAll(/[^.]*\b(?:gray|grey)\s*scale\b[^.]*/gi)]
    .map((match) => match[0].trim())
    .join(' ');
  const ranges = [];
  for (const match of grayText.matchAll(/(\d{1,3})\s*%\s*(?:and|to|through|–|—|-)\s*(\d{1,3})\s*%/gi)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) ranges.push([from, to]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let deadZone = null;
  if (ranges.length >= 2) {
    let widest = null;
    for (let i = 1; i < ranges.length; i += 1) {
      const gap = ranges[i][0] - ranges[i - 1][1];
      if (gap > 0 && (!widest || gap > widest.gap)) {
        widest = { gap, from: ranges[i - 1][1], to: ranges[i][0] };
      }
    }
    if (widest) deadZone = [widest.from, widest.to];
  }
  const backgroundGrayscaleRule = ranges.length
    ? {
        allowed: ranges.map(([from, to]) => `${from}%–${to}%`),
        deadZone,
        text: grayText.slice(0, 180)
      }
    : null;

  const improperUseList = [];
  const pushImproper = (raw) => {
    const item = String(raw)
      .replace(/^(?:[-–—•·*]+|\d+[.)])\s*/, '')
      .trim();
    if (!/^(?:do not|don['’]t|never|no\b|avoid|must not)/i.test(item)) return;
    if (item.length < 6 || item.length > 140) return;
    if (improperUseList.length >= 10) return;
    if (improperUseList.some((existing) => existing.toLowerCase() === item.toLowerCase())) return;
    improperUseList.push(item);
  };

  let inImproperSection = false;
  for (const line of String(rawText || '').split(/\r?\n/)) {
    const clean = line.replace(/\[Page \d+\]/g, '').trim();
    if (!clean) continue;

    // Text extraction glues the heading to the end of the previous sentence, so the
    // heading is found anywhere in the line and its remainder is still read.
    const heading = clean.match(
      /(?:logo\s+improper\s+use|improper\s+use|co-branding\s+requirements|logo\s+misuse)/i
    );
    if (heading) {
      inImproperSection = true;
      const rest = clean.slice(heading.index + heading[0].length).replace(/^[\s:.\-–—]+/, '');
      if (rest) pushImproper(rest);
      continue;
    }
    if (!inImproperSection) continue;
    // A new ALL-CAPS spread title ends the block; the bullets beneath it do not.
    if (/^[A-Z][A-Z\s&/-]{4,}$/.test(clean) && clean.length <= 45) {
      inImproperSection = false;
      continue;
    }
    pushImproper(clean);
  }

  const hasRule =
    forbidStretch ||
    forbidRecolor ||
    forbidAngle ||
    requireClearSpace ||
    Boolean(minSizeRule) ||
    Boolean(backgroundGrayscaleRule) ||
    improperUseList.length > 0;
  if (!hasRule) return null;

  return {
    forbidStretch,
    forbidRecolor,
    forbidAngle,
    requireClearSpace,
    clearSpaceMultiplier,
    minSizeRule,
    backgroundGrayscaleRule,
    improperUseList
  };
}

export function parseRawGuidelines(
  rawText,
  sourceName = 'Uploaded Brand Guideline',
  visualColors = [],
  logoSpec = null
) {
  // Brand books write rules as sentences, but splitting on every period sliced
  // decimals ("5.33 oz") and abbreviations in half. A break now needs a real
  // newline or a capitalised new sentence.
  const wrappedLines = rawText
    .split(/(?:\r?\n|(?<=[.!?])\s+(?=[A-Z"'“”]))/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3);

  // 0. Narrow print columns wrap mid-sentence: "while the word Starbucks in the WPS
  // wordmark" / "should be no smaller than .5\" (13mm) height." A lowercase
  // continuation belongs to the line above unless that line already closed itself.
  const isListLine = (text) => /^(?:[-–—•·*]|\d+[.)])\s+/.test(text);
  const isHeadingLine = (text) => {
    // The page tag is a prefix on the heading, not part of it: "[Page 8] Discounting
    // Guidelines" is still a title, so the bullet beneath it must not be swallowed.
    const bare = text.replace(/^\[Page \d+\]\s*/, '');
    return /^[A-Z]/.test(bare) && bare.split(/\s+/).length <= 6 && !/[.,;]$/.test(bare);
  };

  const lines = [];
  wrappedLines.forEach((line) => {
    const previous = lines[lines.length - 1];
    // A bullet under a heading, or a line under a short title, is a new item — not
    // a wrapped continuation of that heading.
    const canContinue =
      previous && !isListLine(line) && !isHeadingLine(previous) && !/[.!?:]$/.test(previous);
    if (previous && /^[a-z]/.test(line) && canContinue) {
      lines[lines.length - 1] = `${previous} ${line}`;
    } else {
      lines.push(line);
    }
  });
  const brandName = inferBrandName(rawText, sourceName);

  // 1. Written colour values (#HEX, rgb(), R/G/B) and the palette rows that lost
  // their "#" in OCR. Sampled artwork colours join them after the line pass.
  const writtenSwatches = extractColorSwatches(rawText, sourceName);
  const sectionColors = [];
  // Monochrome brands often name their palette instead of printing hex values:
  // "Black, White, Off-White, Volt, Orange". Without this, a Nike deck yields no
  // usable palette at all because there is nothing chromatic to sample.
  const namedColors = [];
  const NAMED_COLORS = [
    [/\bvolt\b/i, '#CEFF00', 'Volt'],
    [/\boff[\s-]?white\b/i, '#F5F5F5', 'Off-White'],
    [/\bblack\b/i, '#111111', 'Black'],
    [/\bwhite\b/i, '#FFFFFF', 'White'],
    [/\bgr[ae]y\b/i, '#7E7E7E', 'Grey'],
    [/\borange\b/i, '#FA5400', 'Orange'],
    [/\bred\b/i, '#E11D48', 'Red'],
    [/\bgreen\b/i, '#00704A', 'Green'],
    [/\byellow\b/i, '#FFC72C', 'Yellow']
  ];
  NAMED_COLORS.forEach(([pattern, hex, name]) => {
    if (pattern.test(rawText)) {
      namedColors.push({ hex, name, source: `${sourceName} (Named Brand Colour)` });
    }
  });

  const bannedTerms = [];
  const facts = [];
  let currentPage = 'Doc';
  // Brand decks list their rules under headings instead of writing "Never use..."
  // sentences, so the heading a line sits beneath decides how that line is read.
  let currentSection = 'neutral';
  let restrictionKind = '';

  lines.forEach((line, idx) => {
    const pageTag = line.match(/\[Page (\d+)\]/);
    if (pageTag) {
      currentPage = `Page ${pageTag[1]}`;
      // A bullet block belongs to its own page, not to whatever follows the break
      if (currentSection === 'restriction') currentSection = 'neutral';
    }
    const cleanLine = line.replace(/\[Page \d+\]\s*/, '').trim();
    if (!cleanLine) return;

    const bulletText = cleanLine.replace(/^(?:[-–—•·*]+|\d+[.)])\s*/, '').trim();
    if (!bulletText) return;

    // "Discounting Guidelines" and "Logo Improper Use" are headings over bullet
    // lists, and the list is the rule. Checked before the generic heading pass, which
    // would otherwise file "Logo Improper Use" away as a skipped logo section.
    const restrictionHeading = cleanLine.length <= 80 && cleanLine.match(RESTRICTION_SECTION_HEADING);
    if (restrictionHeading) {
      currentSection = 'restriction';
      restrictionKind = /discount|coupon|promotion|cents-off|percent-off|free|bundl|offer/i.test(cleanLine)
        ? 'discounting'
        : 'other';
      return;
    }

    // A heading decides how everything beneath it reads: a Negative Keywords block
    // is a rule even though no line in it says "never use".
    const headingRole = detectSectionHeading(bulletText, currentSection);
    if (headingRole) {
      currentSection = headingRole;
      if (headingRole === 'colors') collectSectionColors(bulletText, sectionColors, sourceName);
      return;
    }

    if (currentSection === 'negative' || currentSection === 'positive') {
      if (currentSection === 'negative') {
        const term = tidyTerm(bulletText);
        if (isPlausibleKeyword(term)) {
          bannedTerms.push({
            id: `RULE-T${bannedTerms.length + 1}`,
            term,
            replacement: null,
            reason: 'Listed under a Negative Keywords section',
            citation: `${sourceName}: Negative Keyword ('${bulletText}')`
          });
        }
      }
      return;
    }

    if (currentSection === 'colors') {
      collectSectionColors(bulletText, sectionColors, sourceName);
      return;
    }

    if (currentSection === 'fonts' || currentSection === 'logo') return;

    const citation = `${sourceName} (${currentPage}): "${cleanLine.slice(0, 95)}"`;
    const pushRule = (term, replacement, reason, citationOverride) => {
      if (!term) return;
      bannedTerms.push({
        id: `RULE-T${bannedTerms.length + 1}`,
        term,
        replacement,
        reason,
        citation: citationOverride || citation
      });
    };

    // 1b. Bullets and numbered directives under a restriction heading. A discounting
    // ban is worth little if the only captured rule is the heading, so the concrete
    // promotional hooks and every quoted example are indexed as terms with a
    // citation that points at the section a reviewer can verify.
    if (currentSection === 'restriction') {
      const item = bulletText.replace(/\s+/g, ' ').trim();
      if (!item) return;
      const quoted = [...cleanLine.matchAll(/["'“”]([^"'“”]{2,48})["'“”]/g)].map((m) => m[1].trim());

      if (restrictionKind === 'discounting') {
        const discountCitation = `Discounting Guidelines (${currentPage}): "${cleanLine.slice(0, 95)}"`;
        DISCOUNT_TRIGGER_TERMS.forEach((term) =>
          pushRule(
            term,
            null,
            'Discounting, coupons and free offers are prohibited by the brand guidelines',
            discountCitation
          )
        );
        quoted.forEach((example) =>
          pushRule(example, null, 'Quoted example of a prohibited discount promotion', discountCitation)
        );
        if (item.length <= 90) {
          pushRule(item, null, 'Prohibited discounting practice', discountCitation);
        }
        return;
      }

      // Logo misuse: "1. Do not stretch or distort the logo" is a real directive
      const isDirective = /^(?:do not|don['’]t|never|no\b|avoid|must not|not\b)/i.test(item);
      if (isDirective && item.length <= 120) {
        pushRule(item, null, 'Prohibited logo usage listed in the brand guidelines');
      }
      return;
    }

    // 2. Reverse-order directive: "Use "email campaign" instead of "e-mail blast"."
    const reverseSwap = cleanLine.match(
      /(?:use|prefer|say)\s+["'“”]([^"'“”]{2,30})["'“”]\s+(?:instead of|rather than|not)\s+["'“”]([^"'“”]{2,30})["'“”]/i
    );

    // 3. Forward directive: "Instead of X, use Y" or "Replace X with Y"
    const swapRegex = /(?:instead of|replace|rather than|do not use|never use|avoid)\s+["'“”]?([^"'“”,.;]+)["'“”]?\s*(?:,\s*)?(?:use|say|write|with|prefer)\s+["'“”]?([^"'“”,.;]+)["'“”]?/i;
    const swapMatch = reverseSwap ? null : cleanLine.match(swapRegex);

    if (reverseSwap) {
      pushRule(
        reverseSwap[2].trim().toLowerCase(),
        reverseSwap[1].trim(),
        'Reverse replacement directive in brand guidelines'
      );
    } else if (swapMatch) {
      pushRule(
        swapMatch[1].trim().toLowerCase(),
        swapMatch[2].trim(),
        'Explicit replacement directive in brand guidelines'
      );
    }

    // 4. Prohibited words, quoted or written straight into the sentence
    const isProhibitive = /\b(never|avoid|banned|prohibited|forbidden|do not|don['’]t|must not|off-brand|stop using)\b/i.test(cleanLine);
    if (isProhibitive && !swapMatch && !reverseSwap) {
      // "Don't say effortless", "Avoid using the word hack", "Never say X when Y"
      // Curly apostrophes come out of PDF text extraction as often as straight ones
      const unquotedRegex = /(?:do not|don['’]t|never|avoid)\s+(?:say|saying|use|using|write|writing|call it|refer to [a-z]+ as)\s+["'“”]?([a-zA-Z0-9\s-]{3,28}?)["'“”]?(?:[.,;]|$|\s+(?:in|when|because|as|instead))/gi;
      for (const match of cleanLine.matchAll(unquotedRegex)) {
        const term = tidyTerm(match[1]);
        if (term.length >= 2 && !EMPTY_TERMS.test(term)) {
          pushRule(term, null, 'Prohibited term stated without quotation marks');
        }
      }

      const quotedWords = [...cleanLine.matchAll(/["'“”]([^"'“”]{2,35})["'“”]/g)].map((m) => m[1]);
      quotedWords.forEach((word) => {
        const term = word.trim().toLowerCase();
        if (term) pushRule(term, null, 'Prohibited term specified in uploaded guidelines');
      });

      const colonList = cleanLine.match(/(?:words|terms|phrases|avoid|banned|prohibited)\s*:\s*([^.]+)/i);
      if (colonList) {
        colonList[1].split(/,|;/).forEach((item) => {
          const cleaned = item.replace(/["'“”]/g, '').trim().toLowerCase();
          if (cleaned.length >= 2 && cleaned.length <= 30) {
            pushRule(cleaned, null, 'Listed under prohibited terminology');
          }
        });
      }
    }

    // 5. Verified metrics, plus genuine prose (mission, description, market-leadership
    // statements) so a claim can be checked against the brand's own words.
    const metricLine = cleanLine
      .replace(/#[0-9a-fA-F]{3,8}\b/g, ' ')
      .replace(/rgba?\([^)]*\)/gi, ' ')
      .replace(/\bR\s*[:=]?\s*\d{1,3}\b[\s,;|/]*\bG\s*[:=]?\s*\d{1,3}\b[\s,;|/]*\bB\s*[:=]?\s*\d{1,3}\b/gi, ' ')
      // Font sizes, clock times and "1971-Now" range headers are typography, not claims
      .replace(/\b\d{1,4}\s*(?:pt|px|dp|sp|em|rem)\b/gi, ' ')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
      .replace(/\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|now|present)\b/gi, ' ');

    // OCR loses the punctuation between claims, so split at real sentence boundaries
    // before deciding what the line says; only sentences with a metric trigger count.
    const metricSentences = metricLine
      .split(/[.!?\n]/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 3 && METRIC_TRIGGER.test(sentence));
    // The fact is the metric sentence itself, and only a metric sentence counts: a
    // sentence with no unit, or one carrying OCR damage, never enters the ledger.
    const factSentence = metricSentences[0] || '';

    // Logo sizing, clear-space and print-spec sentences are production instructions,
    // not brand claims: indexing them gave the fact ledger "wordmark no smaller than
    // .5\"" as if it were a verifiable metric.
    const isLayoutSpec = LAYOUT_SPEC_PATTERN.test(cleanLine) || /^[a-z]/.test(cleanLine);

    if (
      !isProhibitive &&
      !isLayoutSpec &&
      !swapMatch &&
      !reverseSwap &&
      isValidHumanSentence(cleanLine) &&
      !hasFactArtifacts(cleanLine) &&
      !isSectionVocabularyLine(cleanLine) &&
      facts.length < MAX_FACTS &&
      isValidMetricFact(factSentence)
    ) {
      const statement = factSentence;
      const doc = nlp(statement);
      const nouns = doc.nouns().out('array');
      // Comma-grouped figures stay one token: "40,000+" must not collapse to "40".
      const numbers = statement.match(/\b\d[\d,]*(?:\.\d+)?(?:\s*%|\+|\s*x|-bit)?\b/g) || [];
      facts.push({
        id: `FACT-${facts.length + 1}`,
        statement,
        numbers: numbers.map((n) => n.trim()),
        keywords: `${nouns.join(' ')} ${statement}`.toLowerCase(),
        citation: `${sourceName} (${currentPage}, Line ${idx + 1})`
      });
    }
  });

  // 5b. Palette. A hex printed in the deck is the brand's own statement: explicit
  // values lead the array in document order and are never filtered, even when they
  // are black, white or grey. Sampled pixels are only a fallback, and near-identical
  // samples collapse by perceptual distance.
  const explicitSwatches = [];
  const seenExplicit = new Set();
  [...namedColors, ...writtenSwatches, ...sectionColors].forEach((swatch) => {
    const hex = (swatch?.hex || '').toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex) || seenExplicit.has(hex)) return;
    seenExplicit.add(hex);
    explicitSwatches.push({
      hex,
      name: swatch.name || describeHex(hex),
      source: swatch.source || sourceName
    });
  });

  const mergedSwatches = [...explicitSwatches];
  if (explicitSwatches.length < MAX_EXPLICIT_COLORS) {
    visualColors.forEach((swatch) => {
      if (mergedSwatches.length >= MAX_EXPLICIT_COLORS) return;
      const hex = (swatch?.hex || '').toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(hex) || seenExplicit.has(hex)) return;
      // "Three purples" are one purple: skip anything the palette already says.
      const duplicate = mergedSwatches.some(
        (existing) => hexDeltaE(hex, existing.hex) < PALETTE_DUPLICATE_DELTA_E
      );
      if (duplicate) return;
      seenExplicit.add(hex);
      mergedSwatches.push({
        hex,
        name: swatch.name || describeHex(hex),
        source: swatch.source || sourceName
      });
    });
  }

  const colors = mergedSwatches.map((swatch, idx) => ({
    id: `CLR-${idx + 1}`,
    ...swatch
  }));

  // 5c. One fact per statement, however often a deck repeats it
  const seenStatements = new Set();
  const indexedFacts = facts
    .filter((fact) => {
      const key = fact.statement
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90);
      if (!key || seenStatements.has(key)) return false;
      seenStatements.add(key);
      return true;
    })
    .map((fact, idx) => ({ ...fact, id: `FACT-${idx + 1}` }));

  // 5d. Tone and prohibition rules. A brand book states most of its restrictions as
  // prose — "we are X, not Y", "avoid …", bullets under a "Don'ts" heading — rather
  // than "Never use …", and those are the lines an ad actually breaks.
  const TONE_HEADING =
    /don['’]?ts|never|avoid|what we are not|improper|prohibited|restrictions|unacceptable|off-brand|words to avoid/i;
  const PROHIBITION =
    /\b(?:do not|don['’]t|never|avoid|must not|cannot|can['’]t|not allowed|incorrect|wrong|prohibited|unacceptable|forbidden|stay away from|refrain from)\s+(?:be\s+|use\s+|using\s+|saying?\s+|says?\s+|writing?\s+|call(?:ed)?\s+(?:it\s+)?|include\s+|show\s+|display\s+|place\s+|add(?:ing)?\s+|make\s+|sound(?:ing)?\s+|describe\s+|claim(?:ing)?\s+)?([a-z][a-z' -]{2,32})/gi;
  const CONTRASTIVE = /\bwe(?:'re| are)\s+([^,.;]{2,40}),\s*not\s+([^,.;]{2,40})/gi;
  // "No stretching", "no altering the mark" — the noun phrase carries the rule.
  const NO_ALTERATION =
    /\bno\s+(?:stretch(?:ing)?|alter(?:ing|ation)?|recolou?r(?:ing)?|distort(?:ion|ing)?|cropp(?:ing)?|rotat(?:ing|ion)?|modif(?:ying|ication)?|chang(?:ing|es)?|editing|additions?|outlin(?:ing|es)?|shadow(?:s|ing)?)\b/gi;
  let tonePage = 'Doc';
  let inToneBlock = false;

  const pushBanned = (rawTerm, reason, page, line) => {
    // "not a lifestyle label" bans "lifestyle label", not the article in front of it.
    const term = tidyTerm(String(rawTerm || '').replace(/^(?:a|an|the)\s+/i, ''));
    if (!term || !isPlausibleKeyword(term)) return;
    // A capture that trails into a sentence is not a keyword.
    if (term.split(/\s+/).length > 4) return;
    if (/^(?:the|a|an|any|our|your|this|that|it|them|their|its)\b/i.test(term)) return;
    if (/^(?:logo|type|font|text|colour|color|image|background|size|space|it|them)$/i.test(term)) return;
    bannedTerms.push({
      id: `RULE-T${bannedTerms.length + 1}`,
      term,
      replacement: null,
      reason,
      citation: `${sourceName}: ${page}, Line ${line}`
    });
  };

  lines.forEach((line, idx) => {
    const pageTag = line.match(/\[Page (\d+)\]/);
    if (pageTag) tonePage = `Page ${pageTag[1]}`;
    const clean = line.replace(/\[Page \d+\]\s*/, '').trim();
    if (!clean) return;
    const bullet = clean.replace(/^(?:[-–—•·*]+|\d+[.)])\s*/, '').trim();
    if (!bullet) return;

    // A short heading ("Don'ts", "Words to avoid", "Off-brand") governs its bullets.
    if (clean.length <= 70 && TONE_HEADING.test(clean) && !/[.!?]$/.test(clean)) {
      inToneBlock = true;
      return;
    }
    const listing = /^(?:[-–—•·*]|\d+[.)])\s+/.test(clean);
    if (inToneBlock && listing) {
      pushBanned(bullet, 'Listed under a prohibited / off-brand heading', tonePage, idx + 1);
      return;
    }
    if (inToneBlock && !listing && /^[A-Z][A-Z\s&/-]{3,}$/.test(clean)) inToneBlock = false;

    const contrastive = clean.match(CONTRASTIVE);
    if (contrastive) {
      pushBanned(contrastive[2], 'Contrastive tone rule ("we are X, not Y")', tonePage, idx + 1);
    }

    for (const match of clean.matchAll(PROHIBITION)) {
      pushBanned(match[1], 'Prohibition stated in the brand book', tonePage, idx + 1);
    }
    for (const match of clean.matchAll(NO_ALTERATION)) {
      pushBanned(
        match[0].replace(/^no\s+/i, ''),
        'Prohibition stated in the brand book',
        tonePage,
        idx + 1
      );
    }
  });

  // 6. One rule per term, however many times a brand book repeats itself
  const seenTerms = new Set();
  const uniqueTerms = bannedTerms
    .map((rule) => ({ ...rule, term: tidyTerm(rule.term) }))
    .filter((rule) => {
      if (!rule.term || rule.term.length < 2 || EMPTY_TERMS.test(rule.term)) return false;
      if (seenTerms.has(rule.term)) return false;
      seenTerms.add(rule.term);
      return true;
    })
    .map((rule, idx) => ({ ...rule, id: `RULE-T${idx + 1}` }));

  // 7. Universal Anti-Slop Baseline
  const defaultSlop = [
    { id: 'SLOP-01', term: 'delve', replacement: 'explore', reason: 'Generic AI-slop verb', citation: 'Universal Anti-Slop Standard' },
    { id: 'SLOP-02', term: 'testament to', replacement: 'proof of', reason: 'Overused LLM filler phrase', citation: 'Universal Anti-Slop Standard' },
    { id: 'SLOP-03', term: 'game-changing', replacement: 'high-impact', reason: 'Unverified promotional buzzword', citation: 'Universal Anti-Slop Standard' },
    { id: 'SLOP-04', term: 'tapestry', replacement: 'ecosystem', reason: 'AI-generated filler metaphor', citation: 'Universal Anti-Slop Standard' }
  ].filter((rule) => !seenTerms.has(rule.term));

  return {
    sourceName,
    brandName,
    rawText,
    // No fallback palette: if neither the text nor the artwork produced a colour the
    // array stays empty. Injecting black/white here made the audit accuse banners of
    // using colours the brand book never specified.
    colors,
    bannedTerms: [...uniqueTerms, ...defaultSlop],
    facts: indexedFacts,
    // Built-in FTC / EPA / QSR / FinTech claim rules, annotated with the deck's own
    // wording when the brand book states the requirement itself.
    regulatoryRules: collectRegulatoryRules(rawText),
    minContrastRatio: 4.5,
    // Reference mark cropped off the deck (null for pasted text) and the usage rules
    // the same deck states around it. The banner audit cross-checks both.
    logoSpec: logoSpec || null,
    logoConditions: parseLogoConditions(rawText)
  };
}
