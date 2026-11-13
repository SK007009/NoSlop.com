import { useEffect, useMemo, useRef, useState } from 'react';
import { diffWords } from 'diff';
import {
  ShieldCheck, Upload, FileText, Image as ImageIcon, CheckCircle2,
  Sparkles, GitPullRequest, BarChart3, Lock, Plus, Trash2, RotateCcw
} from 'lucide-react';
import { extractTextFromPDF, extractGuidelinesFromImage, parseRawGuidelines } from './utils/guidelineParser';
import {
  auditAdText,
  auditAdImage,
  auditSemanticClaims,
  computeGovernanceScore
} from './utils/auditEngine';
import {
  warmUpLocalAi,
  subscribeLocalAi,
  getLocalAiStatus,
  refineAmbiguousRuleWithLLM
} from './utils/localAiEngine';
import LandingPage from './LandingPage';

// A rule with no authored replacement has no wording worth injecting, and any
// generated placeholder is just as empty. Both mean "delete it", never "paste
// this token into the ad copy".
// One vision engine only: the fast, tested CLIP ViT-B/32. The high-res ViT-B/16 tier
// was never validated end-to-end, so it is neither selectable nor ever downloaded.
const VISION_ENGINE = 'Xenova/clip-vit-base-patch32';
const VISION_ENGINE_LABEL = 'Xenova / CLIP-ViT-B/32';

const isPlaceholderFix = (fix) =>
  !fix ||
  /approved (brand )?terminology|approved alternative|remove or rephrase|custom replacement/i.test(
    String(fix).trim()
  );

// Only authored copy is editable here. A hex value, a grayscale level, a logo colour
// or type baked into a raster cannot be rewritten by a text editor, so those cards
// route to the artwork instead of offering a fix that cannot act on the file.
// A finding can only "live in the artwork" when artwork was actually audited: with no
// banner loaded, every finding that is not explicitly image-origin belongs to the
// text box, even if an older rule forgot to tag its `source`.
const isEditableTextIssue = (issue, adCopy = '', hasImage = false) => {
  if (!issue) return false;
  const copy = String(adCopy || '');
  const isImageOnly = issue.source === 'image' || issue.actionType === 'edit-image';
  if (!hasImage && copy.trim().length > 0 && !isImageOnly) return true;
  if (issue.source === 'copy' || issue.actionType === 'append-disclaimer') return true;
  if (isImageOnly) return false;
  const category = String(issue.category || '');
  if (/^(Image|Visual|Logo|Vision AI|WCAG|Contrast|Palette)/i.test(category)) return false;
  const flagged = String(issue.offendingText || '').trim().toLowerCase();
  if (!flagged) return false;
  return copy.toLowerCase().includes(flagged);
};

const TERMINOLOGY_CATEGORIES = /Banned Terminology|AI Slop|Terminology Violation/i;

// "Delve" → "explore" must not touch "delved" or "delver": the term is replaced as
// a whole word, case-insensitively, with every other character left exactly as typed.
const replaceWholeTerm = (text, term, replacement) => {
  const raw = String(term || '');
  if (!raw) return String(text || '');
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]");
  const lead = /^[a-z0-9]/i.test(raw) ? '\\b' : '';
  const trail = /[a-z0-9]$/i.test(raw) ? '\\b' : '';
  return String(text || '').replace(new RegExp(`${lead}${escaped}${trail}`, 'i'), replacement);
};

// Deleting a term leaves its punctuation orphaned ("payment hack!" -> "payment !"),
// so collapse the gap and pull stray spaces off the punctuation that follows.
const stripOffendingText = (text, offending) =>
  String(text)
    .replace(offending, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([!.,?;:])/g, '$1')
    .trim();

// The banner pass audits OCR text and the copy pass sees that same OCR text as
// context, so one regulated claim can surface twice. Keep one card per
// (category, offending text), preferring the copy-level finding that arrives first.
// The sentence an issue lives in. Rewriting must never hand the model the entire
// draft: a fix for one banned word would come back as a rewritten campaign.
const dedupeIssues = (list) => {
  const seen = new Set();
  return list.filter((issue) => {
    const key = `${String(issue.category || '').replace(/^Image OCR:\s*/, '')}|${String(
      issue.offendingText || ''
    ).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// 1-click real-world brand benchmarks so judges can demo without their own files.
// Each guideline block is written the way an actual brand book reads: named swatches,
// quoted and unquoted directives, and verifiable product metrics.
const AD_PRESETS = [
  {
    id: 'tesla',
    label: 'Automotive & Clean Energy — Tesla',
    sourceName: 'Tesla_Brand_Communications_2026.pdf',
    guidelines: `Tesla Brand & Product Communications Guidelines 2026
Official brand palette is #E82127 (Tesla Red), #171A20 (Obsidian Black), and #FFFFFF (Pure White).
Instead of "self-driving", use "Full Self-Driving (Supervised)".
Never use the words "exhaust", "gas-guzzler", or "autopilot drives itself".
Model Y achieves an EPA-estimated range of 330 miles per charge.
Vehicles are backed by an 8-year battery warranty across 40+ countries.`,
    adText: `Delve into Tesla's game-changing autonomous car where autopilot drives itself!
Release more sustainable exhaust with a 500 miles range per charge and a 15-year battery warranty.
100% zero-risk self-driving guaranteed!`
  },
  {
    id: 'mcdonalds',
    label: 'QSR — McDonald\u2019s',
    sourceName: 'McDonalds_Golden_Arches_Standards_2026.pdf',
    guidelines: `McDonald's Golden Arches Brand Standards 2026
Official brand palette is #DA291C (McDonald's Red), #FFC72C (Golden Arches Yellow), and #27251F (Neutral Black).
Instead of "junk food", use "iconic favorites".
Never use the words "cheap", "greasy", or "miracle diet".
Angus Third Pounder features 5.33 oz (1/3 lb) of 100% pure beef before cooking.
Served across 40,000+ restaurants globally.`,
    adText: `AWESOME DEALS! Delve into our cheap, greasy Angus Burger with 10 oz of beef before cooking!
Guaranteed #1 miracle diet burger across 90,000 restaurants!`
  },
  {
    id: 'spotify',
    label: 'Audio & Podcasts — Spotify',
    sourceName: 'Spotify_Brand_Partner_Guidelines_2026.pdf',
    guidelines: `Spotify Audio Brand & Partner Guidelines 2026
Official brand palette is #1DB954 (Spotify Green) and #191414 (Pitch Black).
Instead of "songs", use "tracks and podcasts".
Instead of "free forever", use "Spotify Free tier (ad-supported)".
Never use the words "pirated", "hack", or "unbreakable".
Spotify connects over 626 million monthly active users and 100 million tracks across 180 markets.`,
    adText: `Delve into this Spotify hack to stream 500 million songs free forever with zero ads across 250 markets!
Guaranteed 100% unlimited offline downloads!`
  },
  {
    id: 'mailchimp',
    label: 'Email Marketing — Mailchimp',
    sourceName: 'Mailchimp_Content_Style_Guide_2026.pdf',
    guidelines: `Mailchimp Content Style Guide 2026
Official brand palette is #FFE01B (Cavendish Yellow), #241C15 (Peppercorn), and #007C89 (Kale Teal).
Instead of "e-mail", use "email".
Instead of "blast", use "campaign".
Never use the words "spam", "foolproof", or "bulletproof".
Mailchimp empowers 13 million businesses globally with a 99.9% deliverability SLA.`,
    adText: `Send a bulletproof e-mail blast to your customers today!
Join 50 million businesses with a 100% deliverability guarantee and foolproof ROI!`
  }
];

// ---------------------------------------------------------------------------
// Tab 5 — signed PDF confidentiality certificate
//
// The certificate is painted onto an offscreen A4 canvas (1240 × 1754 px, ~150
// DPI) and then wrapped in a single-page PDF by hand: one DCTDecode JPEG image
// XObject plus a short content stream that scales it to the full MediaBox. No PDF
// library and no server round-trip — the bytes are assembled here and handed to
// the browser as a Blob download.
// ---------------------------------------------------------------------------
const CERT_WIDTH = 1240;
const CERT_HEIGHT = 1754;
const CERT_INK = '#121411';
const CERT_LIME = '#D8FF4B';
const CERT_PAPER = '#F3F4EE';
const CERT_MUTED = '#5E6759';
const CERT_SANS = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
const CERT_MONO = 'Consolas, "SF Mono", "Courier New", monospace';
const CERT_SCRIPT = '"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function truncateToWidth(ctx, text, maxWidth) {
  const value = String(text ?? '');
  if (ctx.measureText(value).width <= maxWidth) return value;
  let cut = value;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// Greedy word wrap against the current font, with a hard break for single words
// longer than the box (long URLs / hex strings) and an ellipsis once maxLines
// is reached, so the certificate can never spill onto a second page.
function wrapCanvasText(ctx, text, maxWidth, maxLines = Number.POSITIVE_INFINITY) {
  const lines = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((paragraph) => {
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        lines.push('');
        return;
      }
      let line = '';
      words.forEach((word) => {
        const candidate = line ? `${line} ${word}` : word;
        if (ctx.measureText(candidate).width <= maxWidth) {
          line = candidate;
          return;
        }
        if (line) {
          lines.push(line);
          line = '';
        }
        if (ctx.measureText(word).width <= maxWidth) {
          line = word;
          return;
        }
        let piece = '';
        [...word].forEach((char) => {
          if (piece && ctx.measureText(piece + char).width > maxWidth) {
            lines.push(piece);
            piece = char;
          } else {
            piece += char;
          }
        });
        line = piece;
      });
      if (line) lines.push(line);
    });

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateToWidth(ctx, `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, maxWidth);
  return kept;
}

function renderCertificateCanvas(cert) {
  const canvas = document.createElement('canvas');
  canvas.width = CERT_WIDTH;
  canvas.height = CERT_HEIGHT;
  const ctx = canvas.getContext('2d');
  const W = CERT_WIDTH;
  const H = CERT_HEIGHT;
  const margin = 56;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(18,20,17,0.10)';
  ctx.lineWidth = 2;
  ctx.strokeRect(26, 26, W - 52, H - 52);

  // ── Header banner ────────────────────────────────────────────────────────
  ctx.fillStyle = CERT_INK;
  ctx.fillRect(0, 0, W, 250);
  ctx.fillStyle = CERT_LIME;
  ctx.fillRect(0, 246, W, 4);

  roundRectPath(ctx, margin, 46, 56, 56, 16);
  ctx.fillStyle = CERT_LIME;
  ctx.fill();
  ctx.fillStyle = CERT_INK;
  ctx.font = `bold 28px ${CERT_SANS}`;
  ctx.textAlign = 'center';
  ctx.fillText('N', margin + 28, 86);
  ctx.textAlign = 'left';

  ctx.fillStyle = CERT_LIME;
  ctx.font = `bold 24px ${CERT_SANS}`;
  ctx.fillText('NOSLOP.COM', margin + 76, 76);

  ctx.fillStyle = '#F3F4EE';
  ctx.font = `600 30px ${CERT_SANS}`;
  ctx.fillText('PRE-PUBLICATION BRAND GOVERNANCE', margin + 76, 120);
  ctx.fillText('& CONFIDENTIALITY CERTIFICATE', margin + 76, 158);

  ctx.fillStyle = 'rgba(243,244,238,0.62)';
  ctx.font = `18px ${CERT_SANS}`;
  ctx.fillText(`Certificate ID  ${cert.certificateId}`, margin + 76, 196);
  ctx.fillText(`Issued  ${cert.issuedAt}`, margin + 76, 224);

  // ── Score & status summary ───────────────────────────────────────────────
  const cardY = 294;
  const cardH = 262;
  roundRectPath(ctx, margin, cardY, W - margin * 2, cardH, 22);
  ctx.fillStyle = CERT_PAPER;
  ctx.fill();

  const leftX = margin + 40;
  ctx.fillStyle = CERT_MUTED;
  ctx.font = `600 17px ${CERT_SANS}`;
  ctx.fillText('PRE-PUBLICATION BRAND TRUST SCORE', leftX, cardY + 56);
  ctx.fillStyle = CERT_INK;
  ctx.font = `bold 96px ${CERT_SANS}`;
  ctx.fillText(`${cert.trustScore}%`, leftX - 4, cardY + 152);
  ctx.fillStyle = CERT_MUTED;
  ctx.font = `17px ${CERT_SANS}`;
  ctx.fillText(truncateToWidth(ctx, cert.workflowStatus, 320), leftX, cardY + 198);

  ctx.strokeStyle = 'rgba(18,20,17,0.12)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(margin + 400, cardY + 34);
  ctx.lineTo(margin + 400, cardY + cardH - 34);
  ctx.stroke();

  const summaryRows = [
    ['Workflow Status', cert.workflowStatus],
    ['Compiled Guideline Source', cert.sourceName],
    ['Unresolved Flags', String(cert.unresolvedCount)],
    ['Approved Exception Overrides', String(cert.overrideCount)]
  ];
  summaryRows.forEach(([label, value], index) => {
    const y = cardY + 58 + index * 50;
    ctx.fillStyle = CERT_MUTED;
    ctx.font = `16px ${CERT_SANS}`;
    ctx.fillText(label, margin + 440, y);
    ctx.fillStyle = CERT_INK;
    ctx.font = `600 20px ${CERT_SANS}`;
    ctx.fillText(truncateToWidth(ctx, value, W - margin - 40 - (margin + 440)), margin + 440, y + 24);
  });

  // ── Zero-cloud attestation ───────────────────────────────────────────────
  const bandY = cardY + cardH + 26;
  const bandH = 96;
  roundRectPath(ctx, margin, bandY, W - margin * 2, bandH, 22);
  ctx.fillStyle = CERT_LIME;
  ctx.fill();
  ctx.fillStyle = CERT_INK;
  ctx.font = `bold 18px ${CERT_SANS}`;
  ctx.fillText('ZERO-CLOUD PRIVACY ATTESTATION', margin + 32, bandY + 38);
  ctx.font = `20px ${CERT_SANS}`;
  ctx.fillText(
    '100% On-Device Execution Verified — Zero Cloud LLM Calls, Zero External API Keys, Zero Telemetry.',
    margin + 32,
    bandY + 72
  );

  // ── Audited copy snapshot ────────────────────────────────────────────────
  const copyTitleY = bandY + bandH + 48;
  ctx.fillStyle = CERT_INK;
  ctx.font = `bold 19px ${CERT_SANS}`;
  ctx.fillText('AUDITED COPY SNAPSHOT', margin, copyTitleY);

  const copyBoxY = copyTitleY + 18;
  const copyBoxH = 344;
  roundRectPath(ctx, margin, copyBoxY, W - margin * 2, copyBoxH, 18);
  ctx.fillStyle = '#FAFBF6';
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,17,0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = CERT_INK;
  ctx.font = `21px ${CERT_SANS}`;
  const copyText = cert.adCopy || 'No draft copy was audited for this certificate — the audit covered artwork only.';
  wrapCanvasText(ctx, copyText, W - margin * 2 - 64, 10).forEach((line, index) => {
    ctx.fillText(line, margin + 32, copyBoxY + 48 + index * 28);
  });

  // ── Logged human overrides ───────────────────────────────────────────────
  const overrideTitleY = copyBoxY + copyBoxH + 46;
  ctx.fillStyle = CERT_INK;
  ctx.font = `bold 19px ${CERT_SANS}`;
  ctx.fillText(`LOGGED HUMAN EXCEPTION OVERRIDES (${cert.overrideCount})`, margin, overrideTitleY);

  const overrideBoxY = overrideTitleY + 18;
  const overrideBoxH = 132;
  roundRectPath(ctx, margin, overrideBoxY, W - margin * 2, overrideBoxH, 18);
  ctx.fillStyle = cert.overrideCount > 0 ? '#FAFBF6' : '#F7F8F2';
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,17,0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (cert.overrideCount > 0) {
    ctx.font = `17px ${CERT_SANS}`;
    cert.overrideEntries.slice(0, 4).forEach((entry, index) => {
      ctx.fillStyle = CERT_INK;
      const label = `[${entry.category || 'Exception'}] "${entry.offendingText || entry.issueId}"`;
      ctx.fillText(truncateToWidth(ctx, label, 470), margin + 32, overrideBoxY + 38 + index * 26);
      ctx.fillStyle = CERT_MUTED;
      ctx.fillText(
        truncateToWidth(ctx, `${entry.reason || 'No justification recorded'} — ${entry.actor || 'Reviewer'}`, 560),
        margin + 520,
        overrideBoxY + 38 + index * 26
      );
    });
    if (cert.overrideCount > 4) {
      ctx.fillStyle = CERT_MUTED;
      ctx.fillText(`+ ${cert.overrideCount - 4} more in the JSON audit log`, margin + 32, overrideBoxY + 118);
    }
  } else {
    ctx.fillStyle = CERT_MUTED;
    ctx.font = `18px ${CERT_SANS}`;
    ctx.fillText('None logged — every finding was resolved with a surgical fix before sign-off.', margin + 32, overrideBoxY + 74);
  }

  // ── Signature & cryptographic seal ───────────────────────────────────────
  const sigY = 1318;
  const sigH = 268;
  const gap = 20;
  const leftW = 712;
  const rightW = W - margin * 2 - leftW - gap;

  roundRectPath(ctx, margin, sigY, leftW, sigH, 20);
  ctx.fillStyle = CERT_PAPER;
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,17,0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const badgeX = margin + 76;
  const badgeY = sigY + 76;
  ctx.beginPath();
  ctx.arc(badgeX, badgeY, 42, 0, Math.PI * 2);
  ctx.fillStyle = CERT_INK;
  ctx.fill();
  ctx.strokeStyle = CERT_LIME;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = CERT_LIME;
  ctx.font = `bold 22px ${CERT_SANS}`;
  ctx.textAlign = 'center';
  ctx.fillText(`[${cert.signerInitials}]`, badgeX, badgeY + 8);
  ctx.textAlign = 'left';

  ctx.fillStyle = CERT_MUTED;
  ctx.font = `600 15px ${CERT_SANS}`;
  ctx.fillText('SIGNED BY', margin + 140, sigY + 56);
  ctx.fillStyle = CERT_INK;
  ctx.font = `bold 26px ${CERT_SANS}`;
  ctx.fillText(truncateToWidth(ctx, cert.signerName, leftW - 172), margin + 140, sigY + 92);

  ctx.fillStyle = '#243024';
  ctx.font = `italic 40px ${CERT_SCRIPT}`;
  const signature = cert.signerName.replace(/\s*\([^)]*\)\s*/g, ' ').trim() || cert.signerName;
  ctx.fillText(truncateToWidth(ctx, signature, leftW - 100), margin + 44, sigY + 168);

  ctx.strokeStyle = 'rgba(18,20,17,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(margin + 40, sigY + 186);
  ctx.lineTo(margin + leftW - 40, sigY + 186);
  ctx.stroke();

  ctx.fillStyle = CERT_MUTED;
  ctx.font = `17px ${CERT_SANS}`;
  ctx.fillText(truncateToWidth(ctx, `Role: ${cert.role}`, leftW - 80), margin + 40, sigY + 216);
  ctx.fillText(
    truncateToWidth(ctx, 'Platform: NoSlop.com On-Device Governance Engine (Team Kaizen)', leftW - 80),
    margin + 40,
    sigY + 244
  );

  const sealX = margin + leftW + gap;
  roundRectPath(ctx, sealX, sigY, rightW, sigH, 20);
  ctx.fillStyle = CERT_INK;
  ctx.fill();

  ctx.fillStyle = CERT_LIME;
  ctx.font = `bold 14px ${CERT_SANS}`;
  ctx.fillText('WEB CRYPTO SHA-256', sealX + 26, sigY + 44);
  ctx.fillText('ASSET & AUDIT SEAL', sealX + 26, sigY + 66);

  const digest = cert.digest || 'computing…';
  ctx.fillStyle = '#F3F4EE';
  ctx.font = `15px ${CERT_MONO}`;
  const digestLines = digest.length > 32 ? [digest.slice(0, 32), digest.slice(32)] : [digest];
  digestLines.forEach((line, index) => ctx.fillText(line, sealX + 26, sigY + 102 + index * 22));

  ctx.fillStyle = 'rgba(243,244,238,0.62)';
  ctx.font = `13px ${CERT_SANS}`;
  wrapCanvasText(
    ctx,
    'SHA-256 over brand source, audited copy, trust score, signer role and signer name. Hash computed in-browser by crypto.subtle.digest — no network round-trip.',
    rightW - 52,
    4
  ).forEach((line, index) => ctx.fillText(line, sealX + 26, sigY + 178 + index * 19));

  // ── Footer ───────────────────────────────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.fillStyle = CERT_MUTED;
  ctx.font = `16px ${CERT_SANS}`;
  ctx.fillText(
    'Generated on-device by NoSlop.com • Team Kaizen • No document, image or draft left this browser tab.',
    W / 2,
    1636
  );
  ctx.fillStyle = 'rgba(94,103,89,0.85)';
  ctx.font = `15px ${CERT_SANS}`;
  ctx.fillText('Attestation covers the audit run, resolved flags and remediated copy recorded above.', W / 2, 1666);
  ctx.textAlign = 'left';

  return canvas;
}

// Minimal single-page PDF wrapper around a JPEG: Catalog → Pages → Page →
// Image XObject (DCTDecode) + content stream, with a byte-accurate xref table.
function buildPdfFromJpeg(jpegBytes, width, height) {
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [];
  let cursor = 0;

  const write = (chunk) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    cursor += bytes.length;
  };
  const beginObject = (id, dict) => {
    offsets[id] = cursor;
    write(`${id} 0 obj\n${dict}\n`);
  };
  const endObject = () => write('endobj\n');

  // Binary comment on line 2 marks the file as containing binary data.
  write(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  beginObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  endObject();
  beginObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  endObject();
  beginObject(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ' +
      '/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>'
  );
  endObject();

  // `beginObject` appends the object's trailing newline, so these dicts end at the
  // `stream` keyword: the declared /Length must cover exactly the bytes that
  // follow, or a reader truncates the JPEG by one byte.
  beginObject(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream`
  );
  write(jpegBytes);
  write('\nendstream\n');
  endObject();

  const content = 'q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n';
  beginObject(5, `<< /Length ${content.length} >>\nstream`);
  write(`${content}endstream`);
  endObject();

  const xrefOffset = cursor;
  const objectCount = 6;
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let id = 1; id < objectCount; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  write(xref);
  write(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}

// Canvas → JPEG bytes → PDF Blob.
function certificatePdfBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error('The certificate canvas could not be encoded as a JPEG.'));
          return;
        }
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          resolve(buildPdfFromJpeg(bytes, canvas.width, canvas.height));
        } catch (err) {
          reject(err);
        }
      },
      'image/jpeg',
      0.94
    );
  });
}

// Banner preview with an SVG bounding-box layer over the OCR word regions
function AdBannerWithBoxes({ src, report }) {
  const [dims, setDims] = useState(null);
  // Tesseract emits one box per word fragment, so "selling" can arrive as an "s" box
  // and an "elling" box. Boxes sharing a centreline within 10 px are joined before
  // they are drawn.
  const groupBoxesIntoLines = (input) => {
    const lines = [];
    [...input]
      .sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
      .forEach((box) => {
        const centreY = (box.y0 + box.y1) / 2;
        const tolerance = Math.max(3, (box.y1 - box.y0) / 2);
        const line = lines.find((entry) => Math.abs(entry.centreY - centreY) <= tolerance);
        if (line) {
          line.boxes.push(box);
          line.centreY = (line.centreY * (line.boxes.length - 1) + centreY) / line.boxes.length;
        } else {
          lines.push({ centreY, boxes: [box] });
        }
      });
    return lines.flatMap((line) =>
      line.boxes
        .sort((a, b) => a.x0 - b.x0)
        .reduce((merged, box) => {
          const prev = merged[merged.length - 1];
          if (prev) {
            const gap = box.x0 - prev.x1;
            if (gap < 10) {
              prev.x1 = Math.max(prev.x1, box.x1);
              prev.y0 = Math.min(prev.y0, box.y0);
              prev.y1 = Math.max(prev.y1, box.y1);
              prev.text = [prev.text, box.text].filter(Boolean).join(' ');
              prev.failsContrast = prev.failsContrast || box.failsContrast;
              prev.contrast =
                prev.contrast == null
                  ? box.contrast
                  : box.contrast == null
                    ? prev.contrast
                    : Math.min(prev.contrast, box.contrast);
              return merged;
            }
          }
          merged.push({ ...box });
          return merged;
        }, [])
    );
  };

  const boxes = groupBoxesIntoLines(
    (report?.boundingBoxes || []).filter((box) => box.x1 > box.x0 && box.y1 > box.y0)
  );
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

// On-device model status: a green dot once both pipelines are resident in the tab, a
// spinner while a cold download or an in-flight generation is running.
function LocalAiBadge({ status }) {
  const loading = status.status === 'loading';
  const thinking = status.busy > 0;
  const ready = status.status === 'ready';
  const failed = status.status === 'error';
  const label = thinking
    ? 'Local WASM AI: Thinking…'
    : ready
      ? 'Local WASM AI: Ready (flan-t5-small + MiniLM-L6-v2)'
      : loading
        ? `Local WASM AI: Loading ${status.percent}%`
        : failed
          ? 'Local WASM AI: Offline — deterministic fallback'
          : 'Local WASM AI: Idle';
  const dot = failed ? 'bg-[#DF7A7A]' : ready ? 'bg-[#3F6B3A]' : 'bg-[#8A6D1F]';

  return (
    <span
      title={failed && status.error ? `${status.message} (${status.error})` : status.message}
      className="inline-flex items-center gap-2 bg-[#F3F4EE] px-3.5 py-2 rounded-full border border-black/10 text-[11px] font-medium text-[#2B3129] whitespace-nowrap"
    >
      {loading || thinking ? (
        <span className="w-3 h-3 rounded-full border-2 border-[#121411]/25 border-t-[#121411] animate-spin" />
      ) : (
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      )}
      {label}
    </span>
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

// One horseshoe, two paths: a grey track and a single progress stroke on the same
// arc. The old three-segment arc bled where segments met and left a stray red dot.
const TRUST_ARC_PATH = 'M 25 120 A 85 85 0 1 1 195 120';

function TrustArcGauge({ trustScore, unresolvedCount, overriddenCount, hasAudited, workflowStatus }) {
  const score = hasAudited ? Math.max(0, Math.min(100, Math.round(Number(trustScore) || 0))) : 0;
  const healthy = score === 100;
  const statusLabel = !hasAudited ? 'Awaiting Audit' : unresolvedCount > 0 ? 'Needs Remediation' : 'Compliant';

  return (
    <div className="bg-[#F3F4EE] text-[#141712] rounded-[28px] p-6 border border-black/5 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h3 className="text-sm font-semibold tracking-tight">Pre-Publication Brand Trust</h3>
        <ul className="space-y-1.5 text-[11px]">
          {[
            { color: '#10B981', label: `Compliant · ${hasAudited ? `${score}%` : '—'}` },
            { color: '#EF4444', label: `Open Issues · ${unresolvedCount + overriddenCount}` }
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
          viewBox="0 0 220 140"
          role="img"
          aria-label={hasAudited ? `Brand trust score ${score}%` : 'Brand trust score awaiting audit'}
          className="w-full"
        >
          <path
            d={TRUST_ARC_PATH}
            fill="none"
            stroke="#E5E7EB"
            strokeWidth="16"
            strokeLinecap="round"
          />
          {hasAudited && score > 0 && (
            <path
              d={TRUST_ARC_PATH}
              pathLength="100"
              fill="none"
              stroke={healthy ? '#10B981' : '#EF4444'}
              strokeWidth="16"
              strokeLinecap="round"
              strokeDasharray={`${score} 100`}
              strokeDashoffset="0"
              style={{ stroke: healthy ? '#10B981' : '#EF4444' }}
              className="transition-all duration-700 ease-out"
            />
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-6 text-center">
          <span className="text-4xl font-bold tracking-tight text-[#121411]">
            {hasAudited ? `${score}%` : '—'}
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

// The vault is always an object, never null: every Tab 1 card and the Tab 2 audit
// read its arrays directly, so "empty" is this shape rather than a null check.
const EMPTY_BRAND_VAULT = {
  sourceName: 'None Loaded',
  brandName: '',
  rawText: '',
  colors: [],
  bannedTerms: [],
  facts: [],
  regulatoryRules: [],
  minContrastRatio: 4.5,
  logoSpec: null,
  logoConditions: null
};

// Closed-testing demo accounts. The role attached here is the only source of truth
// for RBAC once the user signs in — the workspace has no role switcher.
const DEMO_ACCOUNTS = [
  { id: 'demo_creator', name: 'Demo Creator', email: 'creator@noslop.com', role: 'Creator', avatar: '🎨' },
  { id: 'demo_manager', name: 'Demo Manager', email: 'manager@noslop.com', role: 'Brand Manager (Approver)', avatar: '👔' },
  { id: 'demo_advocate', name: 'Demo Advocate', email: 'legal@noslop.com', role: 'Legal / Compliance', avatar: '⚖️' }
];

// Google-style saved-account picker. A typed email is never honoured: this build is
// closed testing, so the only way in is a pre-provisioned demo identity.
function DemoLoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    setLoginError('Account not registered for closed testing, contact admin.');
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white border border-gray-200 rounded-3xl shadow-[0_20px_60px_rgba(15,23,42,0.08)] p-8">
        <div className="text-center mb-6">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-[#121411] text-[#D8FF4B] flex items-center justify-center">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-gray-900">Sign in to NoSlop</h1>
          <p className="mt-1 text-xs text-gray-500">Brand governance workspace · closed demo</p>
        </div>

        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
          Choose a Saved Account
        </p>
        <div className="space-y-2">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => onLogin(account)}
              className="w-full flex items-center gap-3 text-left border border-gray-200 rounded-2xl px-3 py-2.5 hover:border-gray-400 hover:bg-gray-50 transition cursor-pointer"
            >
              <span className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-lg" aria-hidden="true">
                {account.avatar}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 truncate">{account.name}</span>
                <span className="block text-[11px] text-gray-500 truncate">{account.email}</span>
              </span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 whitespace-nowrap">
                {account.role}
              </span>
            </button>
          ))}
        </div>

        <div className="my-6 flex items-center gap-3 text-[11px] uppercase tracking-wider text-gray-400">
          <span className="h-px flex-1 bg-gray-200" />or login as new user<span className="h-px flex-1 bg-gray-200" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="Email"
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-gray-900 focus:outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="Password"
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-gray-900 focus:outline-none"
          />
          <button
            type="submit"
            className="w-full rounded-xl bg-gray-900 text-white text-sm font-semibold py-2.5 hover:bg-gray-800 cursor-pointer"
          >
            Sign In
          </button>
          {loginError && (
            <p className="text-xs text-red-600" role="alert">
              {loginError}
            </p>
          )}
        </form>

        <p className="mt-4 text-center text-[10px] text-gray-400">
          Demo only — accounts are local, nothing is transmitted.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('landing');
  // 'tabs' shows the five workspace tabs; 'product' and 'guide' are the other two
  // destinations the landing navbar can open inside this same window.
  const [workspaceView, setWorkspaceView] = useState('tabs');
  const [activeTab, setActiveTab] = useState('compiler');
  // Demo authentication gate. `isLoggedIn` renders the workspace; `currentUser` is the
  // signed-in demo identity and the only source of the active role.
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  // The role is locked at sign-in (setActiveRole runs once, in onLogin) — every
  // existing approval check reads this alias, so there is no way to escalate in-app.
  const [activeRole, setActiveRole] = useState('Creator');
  const role = activeRole;
  // Starts genuinely empty: no demo brand book, no pre-filled ad copy, no seeded
  // history. A preset arrives only if the user picks one from the header dropdown.
  const [rawGuidelineText, setRawGuidelineText] = useState('');
  const [isCompiled, setIsCompiled] = useState(false);
  const [sourceName, setSourceName] = useState('');
  // Palette colours sampled from PDF pages / guideline artwork, kept so a manual
  // re-compile still merges what the canvas found.
  const [visualColors, setVisualColors] = useState([]);
  // Human-in-the-loop logo pick: every region the extractor shortlisted, and whether
  // a reviewer has confirmed (or skipped) one yet.
  const [logoCandidates, setLogoCandidates] = useState([]);
  const [logoChoicePending, setLogoChoicePending] = useState(false);
  const [isExtractingGuideline, setIsExtractingGuideline] = useState(false);
  const [parsePercent, setParsePercent] = useState(0);
  const [guidelineProgressText, setGuidelineProgressText] = useState('');
  // Reviewer-typed replacements for banned terms that have no approved wording.
  const [customFixes, setCustomFixes] = useState({});
  const [brandVault, setBrandVault] = useState(EMPTY_BRAND_VAULT);

  // Manual Rule Inputs
  const [newTerm, setNewTerm] = useState('');
  const [newReplacement, setNewReplacement] = useState('');
  const [newFact, setNewFact] = useState('');
  const [newColor, setNewColor] = useState('#6366F1');

  // Ad Auditor State
  const [originalAdText, setOriginalAdText] = useState('');
  const [workingAdText, setWorkingAdText] = useState('');
  const [imagePreview, setImagePreview] = useState(null);
  // Bumped whenever the banner is cleared so the <input type="file"> remounts and
  // drops the File it was holding; without it the same file could not be re-picked.
  const [adInputKey, setAdInputKey] = useState(0);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [isRunningAudit, setIsRunningAudit] = useState(false);
  const [isExtractingAdBanner, setIsExtractingAdBanner] = useState(false);
  const [adAuditProgressText, setAdAuditProgressText] = useState('');
  const [issues, setIssues] = useState([]);
  const [imageReport, setImageReport] = useState(null);
  // Tab 2 vision engine choice and the live telemetry the audit streams back while it
  // downloads weights and reasons over the creative.
  const [visionTelemetry, setVisionTelemetry] = useState(null);
  const [visionElapsed, setVisionElapsed] = useState(0);

  // Workflow & Governance State
  const [workflowStatus, setWorkflowStatus] = useState('Draft — Awaiting Pre-Flight Audit');
  // A status string alone is not proof that an audit ran: every reset path clears
  // this flag, so an empty workspace can never inherit a 100% "publication ready"
  // score from the run that preceded it.
  const [hasRunAudit, setHasRunAudit] = useState(false);
  const [overrides, setOverrides] = useState({});
  // Per-rule edit drafts for the Tab 4 Auto-Refiner, editable before commit
  const [refineDrafts, setRefineDrafts] = useState({});
  // On-device AI: engine status, the rewrites it has drafted (kept out of the draft
  // copy until accepted) and which card / rule is currently being generated.
  const [aiStatus, setAiStatus] = useState(getLocalAiStatus);
  const [autoRefiningId, setAutoRefiningId] = useState('');
  const [revisionHistory, setRevisionHistory] = useState([]);
  const [commentInput, setCommentInput] = useState('');
  const [comments, setComments] = useState([]);

  // Tab 5 — named signer plus the live Web Crypto SHA-256 seal over the artefact
  // being certified. The digest is derived, never typed, so the value on screen
  // can only be the hash of the fields actually shown on the certificate.
  const [signerName, setSignerName] = useState('Satyam (Team Kaizen)');
  const [assetSeal, setAssetSeal] = useState('');
  const [certificateStatus, setCertificateStatus] = useState('');

  // The model reports its own elapsed time while bytes stream in, but the audit as a
  // whole (OCR, logo scan, inference) needs a ticker that keeps moving every 200 ms.
  const visionStartRef = useRef(0);
  useEffect(() => {
    if (!isRunningAudit) return undefined;
    const id = setInterval(() => {
      setVisionElapsed((performance.now() - visionStartRef.current) / 1000);
    }, 200);
    return () => clearInterval(id);
  }, [isRunningAudit]);

  // Load a 1-click industry test case (guidelines + matching ad draft)
  const handleApplyPreset = (e) => {
    const preset = AD_PRESETS.find((p) => p.id === e.target.value);
    e.target.value = '';
    if (!preset) return;

    // A benchmark load is a clean slate: a banner uploaded for another brand, its OCR
    // report and every Tab 2 finding must not survive into this demo.
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(null);
    setImageReport(null);
    setIssues([]);
    setOverrides({});
    setCustomFixes({});
    setVisionTelemetry(null);
    setVisionElapsed(0);
    setOcrProgress(0);
    setAdAuditProgressText('');
    setIsExtractingAdBanner(false);
    setHasRunAudit(false);
    // Remount the file input so it stops holding the previous File object.
    setAdInputKey((key) => key + 1);

    const compiled = parseRawGuidelines(preset.guidelines, preset.sourceName);
    setRawGuidelineText(preset.guidelines);
    setIsCompiled(false);
    setSourceName(preset.sourceName);
    setBrandVault(compiled);
    setOriginalAdText(preset.adText);
    setWorkingAdText(preset.adText);
    setVisualColors([]);
    // Tab 1's visual assets are brand-specific: logo crops shortlisted from a
    // previously uploaded PDF (Starbucks, Nike…) must not sit in the gallery — or
    // stay pending a choice — once a Spotify/Tesla benchmark is loaded.
    setLogoCandidates([]);
    setLogoChoicePending(false);
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
    // The button is locked without input, but the handler guards too: an empty
    // compile would otherwise replace the vault with placeholder rules.
    if (!rawGuidelineText.trim() && visualColors.length === 0) return;
    const compiled = parseRawGuidelines(
      rawGuidelineText,
      sourceName || 'Custom Brand Guidelines',
      visualColors,
      // A re-compile must not throw away the mark already cropped off the deck.
      brandVault.logoSpec || null
    );
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
    setIsExtractingGuideline(true);
    setParsePercent(0);
    setGuidelineProgressText(`Reading ${file.name}…`);

    const onProgress = (percent, message) => {
      setParsePercent(Math.max(0, Math.min(100, Math.round(percent))));
      if (message) setGuidelineProgressText(message);
    };

    try {
      let text = '';
      let sampledColors = [];
      let logoSpec = null;
      let extractedCandidates = [];
      // Only PDFs and images run the canvas scanner; plain text has no artwork to
      // shortlist, so it skips the HITL gallery entirely.
      let logoScanAttempted = false;

      if (lower.endsWith('.pdf')) {
        setGuidelineProgressText('Scanning PDF pages & extracting visual brand rules…');
        const extracted = await extractTextFromPDF(file, onProgress);
        text = extracted.text;
        sampledColors = extracted.visualColors;
        logoSpec = extracted.logoSpec || null;
        extractedCandidates = extracted.candidateLogos || logoSpec?.candidateLogos || [];
        logoScanAttempted = true;
      } else if (/\.(png|jpe?g|webp)$/.test(lower)) {
        setGuidelineProgressText('Scanning image & extracting visual brand rules…');
        const extracted = await extractGuidelinesFromImage(file, onProgress);
        text = extracted.text;
        sampledColors = extracted.visualColors;
        logoSpec = extracted.logoSpec || null;
        extractedCandidates = extracted.candidateLogos || logoSpec?.candidateLogos || [];
        logoScanAttempted = true;
      } else {
        text = await file.text();
        onProgress(100, 'Text file read');
      }

      const trimmed = (text || '').trim();
      const compiled = parseRawGuidelines(trimmed, file.name, sampledColors, logoSpec);
      const candidates = extractedCandidates;
      setVisualColors(sampledColors);
      setBrandVault(compiled);
      // The top-scoring crop is preloaded as the working mark, but the reviewer has
      // the final say: the gallery keeps showing until one is picked or skipped.
      setLogoCandidates(candidates);
      // A scan that found nothing still asks the human: the gallery then offers only
      // manual upload and skip, instead of silently locking a bad crop in.
      setLogoChoicePending(logoScanAttempted);
      // A new brand book invalidates every existing finding: an issue card left over
      // from the previous deck would keep citing a PDF that is no longer loaded. The
      // Tab 2 draft is reset with it — a banner and copy audited against the old deck
      // must not survive the swap, or the next audit reports findings for a brand the
      // user is no longer looking at.
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      setImagePreview(null);
      setImageReport(null);
      setWorkingAdText('');
      setOriginalAdText('');
      setIssues([]);
      setOverrides({});
      setCustomFixes({});
      setVisionTelemetry(null);
      setOcrProgress(0);
      setAdAuditProgressText('');
      // `hasAudited` is derived from this status, and the draft status is what hides
      // the progress bars, horseshoe and reported-issues panels again.
      setHasRunAudit(false);
      setWorkflowStatus('Draft — Awaiting Pre-Flight Audit');

      if (trimmed.length === 0) {
        setRawGuidelineText('');
        setGuidelineProgressText('No readable text found — paste the guideline text below.');
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
      setGuidelineProgressText('Extraction failed — paste the guideline text below.');
    } finally {
      setIsExtractingGuideline(false);
    }
  };

  // A banner only counts as ready once the bitmap has decoded, so the audit stays
  // locked until then and OCR never runs against a blank or broken image.
  const handleAdBannerUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // The uploader is disabled while copy exists; ignoring a stray change event keeps
    // the two inputs mutually exclusive even if the label is triggered programmatically.
    if (workingAdText.trim().length > 0 || isRunningAudit) return;

    setIsExtractingAdBanner(true);
    setAdAuditProgressText(`Preparing ${file.name}…`);
    const objectUrl = URL.createObjectURL(file);
    const probe = new Image();

    probe.onload = () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      setImagePreview(objectUrl);
      setImageReport(null);
      setIssues([]);
      setAdAuditProgressText(
        `Banner ready — ${probe.naturalWidth}×${probe.naturalHeight}px. Run the audit when you are ready.`
      );
      setIsExtractingAdBanner(false);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setAdAuditProgressText('Could not read that image — try a PNG or JPG.');
      setIsExtractingAdBanner(false);
    };
    probe.src = objectUrl;
  };

  // Run Full Pre-Publication Audit
  const handleRunAudit = async () => {
    setIsRunningAudit(true);
    setOcrProgress(0);
    visionStartRef.current = performance.now();
    setVisionElapsed(0);
    setVisionTelemetry({
      phase: 'reasoning',
      step: 'Starting the on-device vision engine…',
      // Fixed engine: the fast, tested CLIP ViT-B/32 repo, always.
      model: VISION_ENGINE,
      modelName: VISION_ENGINE_LABEL
    });
    setAdAuditProgressText('Auditing ad copy against the compiled rules…');

    let imageIssues = [];
    let bannerText = '';
    if (imagePreview) {
      const imgRes = await auditAdImage(
        imagePreview,
        brandVault,
        (percent) => {
          setOcrProgress(percent);
          setAdAuditProgressText(`Scanning banner — OCR, WCAG & vision (${percent}%)…`);
        },
        {
          onTelemetry: setVisionTelemetry,
          // The copy can name a competitor even when the artwork is clean, so the
          // rival-brand scan reads both.
          adCopy: workingAdText
        }
      );
      setImageReport(imgRes);
      imageIssues = imgRes.issues;
      bannerText = imgRes.ocrText || '';
    } else {
      setImageReport(null);
    }

    // The banner's OCR text travels with the copy so a regulated claim printed on the
    // artwork cannot dodge the mandatory-disclaimer check.
    const textIssues = auditAdText(workingAdText, brandVault, { extraText: bannerText });

    setAdAuditProgressText('Comparing claims against the fact ledger…');
    const semanticIssues = await auditSemanticClaims(workingAdText, brandVault);
    // A sentence the deterministic metric check already flagged does not need a
    // second, vector-similarity card saying the same thing about the same number.
    const factFlaggedSentences = new Set(
      [...textIssues, ...imageIssues]
        .filter((issue) => /Contradictory Fact/.test(String(issue.category || '')))
        .map((issue) => String(issue.offendingText || '').trim().toLowerCase())
    );
    const semanticUnique = semanticIssues.filter(
      (issue) => !factFlaggedSentences.has(String(issue.offendingText || '').trim().toLowerCase())
    );
    const combinedIssues = dedupeIssues([...textIssues, ...imageIssues, ...semanticUnique]);

    setIssues(combinedIssues);
    setHasRunAudit(true);
    setWorkflowStatus(combinedIssues.length === 0 ? 'Ready for Approval' : 'Flags Detected — Needs Remediation');
    setRevisionHistory((prev) => [
      { time: new Date().toLocaleTimeString(), actor: role, action: `Ran Pre-Flight Audit: ${combinedIssues.length} compliance flags found` },
      ...prev
    ]);
    setIsRunningAudit(false);
    setVisionTelemetry(null);
    setAdAuditProgressText('');
  };

  // Clearing a finished audit returns the whole Tab 2 surface to its pre-run state,
  // so the text/image exclusivity starts from a blank slate instead of inheriting
  // whichever input the last run happened to use.
  const handleClearAudit = () => {
    if (isRunningAudit || isExtractingAdBanner) return;
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(null);
    setAdInputKey((key) => key + 1);
    setWorkingAdText('');
    setOriginalAdText('');
    setIssues([]);
    setImageReport(null);
    setOverrides({});
    setCustomFixes({});
    setVisionTelemetry(null);
    setVisionElapsed(0);
    setOcrProgress(0);
    setAdAuditProgressText('');
    setHasRunAudit(false);
    setWorkflowStatus('Draft — Awaiting Pre-Flight Audit');
  };

  // Dropping the compiled vault also drops everything audited against it: a finding
  // card left on screen would cite guidelines that are no longer loaded.
  const handleClearVault = () => {
    if (isExtractingGuideline) return;
    setBrandVault(EMPTY_BRAND_VAULT);
    setRawGuidelineText('');
    setSourceName('');
    setVisualColors([]);
    setIsCompiled(false);
    setParsePercent(0);
    setGuidelineProgressText('');
    setLogoCandidates([]);
    setLogoChoicePending(false);
    handleClearAudit();
    setActiveTab('compiler');
  };

  // Judge reset: a factory reset across all five tabs, not just the Tab 2 draft.
  // Tab 3 reads overrides and the revision log, Tab 4 reads the vault and the refine
  // drafts, Tab 5 reads the seal — all of them are wiped with the workspace.
  const handleFactoryReset = () => {
    handleClearVault();
    setRevisionHistory([]);
    setOverrides({});
    setRefineDrafts({});
    setCustomFixes({});
    setSourceName('Custom_Input.txt');
    setAssetSeal('');
    setCertificateStatus('');
  };

  // Human-in-the-loop logo confirmation. Selecting a candidate promotes exactly that
  // crop to the vault; skipping leaves the mark empty so the audit never compares the
  // banner against a product photo.
  const handleSelectLogo = (candidate) => {
    setBrandVault((v) => ({ ...v, logoSpec: { ...candidate, page: v.logoSpec?.page || null } }));
    setLogoChoicePending(false);
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `Confirmed primary brand mark: ${candidate.logoType === 'wordmark' ? 'wordmark' : 'emblem'} at ${candidate.aspectRatio}:1`
      },
      ...prev
    ]);
  };

  // Escape hatch: a deck whose artwork defeats the canvas scanner still gets a real
  // lockup — the user supplies it, and the gallery closes immediately.
  const handleManualLogoUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      const probe = new Image();
      probe.onload = () => {
        setBrandVault((v) => ({
          ...v,
          logoSpec: {
            src: dataUrl,
            aspectRatio: Number((probe.naturalWidth / Math.max(1, probe.naturalHeight)).toFixed(2)),
            logoType: 'manual-upload',
            logoColors: []
          }
        }));
        setLogoChoicePending(false);
        setRevisionHistory((prev) => [
          {
            time: new Date().toLocaleTimeString(),
            actor: role,
            action: `Uploaded the primary brand mark manually (${probe.naturalWidth}×${probe.naturalHeight}px)`
          },
          ...prev
        ]);
      };
      probe.onerror = () => setLogoChoicePending(true);
      probe.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleSkipLogo = () => {
    setBrandVault((v) => ({ ...v, logoSpec: null }));
    setLogoChoicePending(false);
    setRevisionHistory((prev) => [
      { time: new Date().toLocaleTimeString(), actor: role, action: 'Marked the deck as having no usable brand mark (skipped logo selection)' },
      ...prev
    ]);
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
    // A banned term or slop word is swapped as an exact whole word; only genuinely
    // semantic findings fall back to a plain substring replacement.
    const isTerminology = TERMINOLOGY_CATEGORIES.test(String(issue.category || ''));
    setWorkingAdText((prev) =>
      isTerminology
        ? replaceWholeTerm(prev, issue.offendingText, replacement)
        : prev.replace(issue.offendingText, replacement)
    );
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
      setGuidelineProgressText('Type your own replacement wording, or use Remove Word.');
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
      [issue.id]: { reason, ruleId: issue.ruleId, category: issue.category, actor: role, status: 'pending' }
    }));
    setRevisionHistory((prev) => [
      { time: new Date().toLocaleTimeString(), actor: role, action: `Requested exception override on ${issue.id}: "${reason}"` },
      ...prev
    ]);
  };

  // Manager decisions on a creator's exception request: approval drops the penalty
  // from the trust score, rejection deletes the override so the finding is open again.
  const handleApproveOverride = (issue) => {
    setOverrides((prev) => ({
      ...prev,
      [issue.id]: {
        ...prev[issue.id],
        status: 'approved',
        reviewedBy: role,
        reviewedAt: new Date().toISOString()
      }
    }));
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `APPROVED exception on ${issue.id} — penalty removed from the trust score`
      },
      ...prev
    ]);
  };

  const handleRejectOverride = (issue) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[issue.id];
      return next;
    });
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `REJECTED exception on ${issue.id} — the creator must remediate it`
      },
      ...prev
    ]);
  };

  // Primary remediation for a regulated claim: append the mandated footnote to the
  // bottom of the draft, where the diff viewer paints it green.
  const handleAppendDisclaimer = (issue) => {
    // The raw rule text starts with an asterisk for the old inline-footnote style;
    // the appended line is plain "Disclaimer- …".
    const footnote = String(issue.suggestedFix || '')
      .replace(/^[\s*]+/, '')
      .trim();
    if (!footnote) return;
    setWorkingAdText((prev) => {
      const base = String(prev || '').replace(/\s+$/, '');
      return base ? `${base}\n\nDisclaimer- ${footnote}` : `Disclaimer- ${footnote}`;
    });
    setIssues((prev) => prev.filter((i) => i.id !== issue.id));
    setRevisionHistory((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        actor: role,
        action: `Appended mandatory legal disclaimer for [${issue.category}]: "${footnote.slice(0, 64)}…"`
      },
      ...prev
    ]);
  };

  // Tab 4: let the local LLM draft the clarified rule from the reviewers' own
  // justifications, straight into the editable refinement box.
  const handleAutoRefineRule = async (group) => {
    const rule = findVaultRule(group.ruleId);
    const original = rule
      ? rule.statement ||
        (rule.term
          ? `Never use "${rule.term}".${rule.replacement ? ` Use "${rule.replacement}" instead.` : ''} ${rule.reason || ''}`.trim()
          : `Approved brand colour ${rule.hex}${rule.name ? ` (${rule.name})` : ''} may be used for this asset.`)
      : `${group.category || 'Brand'} compliance requirement`;

    setAutoRefiningId(group.ruleId);
    try {
      const refined = await refineAmbiguousRuleWithLLM(
        original,
        group.entries.map((entry) => entry.reason).filter(Boolean)
      );
      if (refined) updateRefineDraft(group.ruleId, { justification: refined });
    } finally {
      setAutoRefiningId('');
    }
  };

  const unresolvedCount = issues.filter((i) => !overrides[i.id]).length;
  // Exception requests still waiting on a manager. Approved ones are settled and no
  // longer count as open work anywhere in the UI.
  const pendingOverrideIssues = issues.filter(
    (issue) => overrides[issue.id] && overrides[issue.id].status !== 'approved'
  );
  const pendingOverrideCount = pendingOverrideIssues.length;
  // A run has happened once the workflow leaves its initial draft state *and* an
  // audit actually completed against the current workspace.
  const hasAudited = hasRunAudit && workflowStatus !== 'Draft — Awaiting Pre-Flight Audit';
  // Weighted checkpoint score: severity penalties, half restored on a logged
  // override (with a 5-point review floor), clamped to 5–100.
  const governance = computeGovernanceScore(issues, overrides, { hasAudited });
  const trustScore = governance.score;
  // A perfect score with nothing outstanding is the one state that is publication
  // ready, whatever label the last audit wrote into workflowStatus.
  const auditAllClear = hasAudited && trustScore === 100 && unresolvedCount === 0;
  // Both auditor inputs are optional individually, but an audit with neither has
  // nothing to read; extraction and a running audit also keep the button locked.
  // Tab 1 ingest gate: typed guidelines, or an upload that sampled at least one
  // colour. Without either there is nothing to compile.
  const hasIngestInput = Boolean(rawGuidelineText.trim()) || visualColors.length > 0;
  const hasAuditInput = workingAdText.trim().length > 0 || Boolean(imagePreview);
  const auditLocked = isExtractingAdBanner || isRunningAudit || !hasAuditInput;
  // Copy and artwork are alternative inputs, never a pair: each locks the other
  // while it is present, so a run can only ever audit one of them at a time.
  // Once an audit has run both inputs freeze: the findings on screen belong to the
  // copy/banner that produced them, so changing either side silently would leave the
  // report describing something the user can no longer see. Clear the audit to edit.
  const vaultEmpty = !brandVault?.sourceName || !Array.isArray(brandVault.rules) || brandVault.rules.length === 0;
  const textInputLocked =
    vaultEmpty || Boolean(imagePreview) || isExtractingAdBanner || isRunningAudit || hasAudited;
  const imageUploadLocked =
    vaultEmpty || workingAdText.trim().length > 0 || isExtractingAdBanner || isRunningAudit || hasAudited;
  const diffs = diffWords(originalAdText, workingAdText);

  // Initials stamp for the signer block: first letter of the first two words.
  // Parentheses and punctuation are skipped so "Satyam (Team Kaizen)" stamps "ST"
  // rather than "S(".
  const signerInitials =
    signerName
      .split(/\s+/)
      .map((word) => word.replace(/[^\p{L}]/gu, '')[0]?.toUpperCase())
      .filter(Boolean)
      .slice(0, 2)
      .join('') || 'SK';

  // Exactly the fields the certificate seals, in a stable order, so the digest
  // changes whenever the brand source, copy, score, role or signer does.
  const sealPayload = JSON.stringify({
    brandVault: brandVault.sourceName,
    workingAdText,
    trustScore,
    activeRole: role,
    signerName
  });

  // Web Crypto only exists in a secure context (https or localhost); when it is
  // missing the seal stays empty and no digest is ever faked.
  const assetSealSupported = Boolean(globalThis.crypto?.subtle);

  useEffect(() => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return undefined;
    let cancelled = false;
    subtle
      .digest('SHA-256', new TextEncoder().encode(sealPayload))
      .then((buffer) => {
        if (cancelled) return;
        setAssetSeal(
          Array.from(new Uint8Array(buffer))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        );
      })
      .catch(() => {
        if (!cancelled) setAssetSeal('');
      });
    return () => {
      cancelled = true;
    };
  }, [sealPayload]);

  useEffect(() => subscribeLocalAi(setAiStatus), []);

  // Warm the WASM pipelines as soon as the workspace opens, so the first audit is
  // not also the first 80 MB download. Failures surface in the badge and every
  // helper falls back to its deterministic path.
  useEffect(() => {
    if (view !== 'app') return undefined;
    const timer = setTimeout(() => warmUpLocalAi(), 800);
    return () => clearTimeout(timer);
  }, [view]);

  // Paint the A4 certificate, wrap it in a PDF and hand it to the browser as a
  // download. Nothing here touches the network: the canvas and the PDF bytes are
  // both produced in this tab.
  const downloadComplianceCertificatePDF = async () => {
    const issuedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
    const certificateId = `NS-${(assetSeal || 'PENDING').slice(0, 10).toUpperCase()}`;
    const overrideEntries = Object.entries(overrides).map(([issueId, override]) => ({
      issueId,
      ...override
    }));

    setCertificateStatus('Rendering certificate…');
    try {
      const canvas = renderCertificateCanvas({
        certificateId,
        issuedAt,
        trustScore,
        workflowStatus,
        sourceName: brandVault.sourceName,
        unresolvedCount,
        overrideCount: overrideEntries.length,
        overrideEntries,
        adCopy: workingAdText.trim(),
        signerName: signerName.trim() || 'Unnamed Signer',
        signerInitials,
        role,
        digest: assetSeal
      });
      const blob = await certificatePdfBlob(canvas);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'NoSlop-Compliance-Certificate.pdf';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setCertificateStatus(`Certificate ${certificateId} downloaded (${Math.round(blob.size / 1024)} KB).`);
      setRevisionHistory((prev) => [
        {
          time: new Date().toLocaleTimeString(),
          actor: role,
          action: `Issued signed PDF certificate ${certificateId} — signed by ${signerName || 'Unnamed Signer'}, SHA-256 ${(assetSeal || 'pending').slice(0, 12)}…`
        },
        ...prev
      ]);
    } catch (err) {
      console.warn('Certificate generation failed:', err);
      setCertificateStatus('Could not build the PDF in this browser — try the JSON export.');
    }
  };

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

  // Closed-testing gate: every entry point into the workspace (Get Started, Launch
  // Workspace, a direct tab link) lands here until a saved account is chosen.
  if (!isLoggedIn) {
    return (
      <DemoLoginPage
        onLogin={(user) => {
          setCurrentUser(user);
          setActiveRole(user.role);
          setIsLoggedIn(true);
          setView('app');
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
          <div className="flex items-center gap-2 bg-[#F3F4EE] px-3.5 py-2 rounded-full border border-black/10">              <span className="text-xs text-[#5E6759]">Real Brand Benchmark:</span>
            <select
              defaultValue=""
              onChange={handleApplyPreset}
              className="bg-transparent text-xs font-semibold text-[#121411] focus:outline-none cursor-pointer max-w-[13rem]"
            >
              <option value="" className="bg-[#F3F4EE] text-[#121411]">Load Real Brand Benchmark...</option>
              {AD_PRESETS.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#F3F4EE] text-[#121411]">
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleFactoryReset}
            className="text-xs px-4 py-2 rounded-full bg-[#F3F4EE] border border-black/10 hover:bg-white text-[#121411] cursor-pointer"
          >
            Clear for Random Judge Input
          </button>

          <LocalAiBadge status={aiStatus} />

          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-[#121411]">
              {currentUser?.avatar} {currentUser?.name}{' '}
              <span className="text-[#5E6759]">({currentUser?.role})</span>
            </span>
            <button
              onClick={() => {
                setIsLoggedIn(false);
                setCurrentUser(null);
              }}
              className="text-sm text-red-600 hover:bg-red-50 px-3 py-1 rounded-md border border-red-200 cursor-pointer"
            >
              Sign Out
            </button>
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
                    isExtractingGuideline ? 'pointer-events-none opacity-60' : ''
                  }`}
                >
                  <Upload className="w-3.5 h-3.5" />
                  {isExtractingGuideline ? 'Extracting…' : 'Upload Guideline (PDF / Image / TXT)'}
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp"
                    onChange={handleGuidelineFileUpload}
                    disabled={isExtractingGuideline}
                    className="hidden"
                  />
                </label>
              </div>
              <div className="h-1 w-full rounded-full bg-[#121510]/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#121510] transition-all duration-500"
                  style={{ width: `${isExtractingGuideline ? Math.max(8, parsePercent) : 42}%` }}
                />
              </div>
              {isExtractingGuideline && (
                <div className="flex items-center justify-between gap-3 text-[11px] text-[#121510]/70">
                  <span>{guidelineProgressText}</span>
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
                disabled={!hasIngestInput || isExtractingGuideline}
                className={`w-full py-2.5 rounded-full bg-[#121411] font-semibold text-sm text-[#D8FF4B] transition ${
                  !hasIngestInput || isExtractingGuideline
                    ? 'opacity-50 cursor-not-allowed pointer-events-none'
                    : 'hover:bg-[#22261f] cursor-pointer'
                }`}
              >
                {isExtractingGuideline ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-[#D8FF4B]/40 border-t-[#D8FF4B] animate-spin" />
                    {guidelineProgressText || 'Extracting PDF / OCR Guidelines (Please wait)...'}
                  </span>
                ) : !hasIngestInput ? (
                  'Upload a Brand Deck or Enter Guidelines First'
                ) : (
                  'Compile Guidelines into Active Rules'
                )}
              </button>
          </div>
        )}

        {/* TAB 1: COMPILED BRAND VAULT RESULTS — ingestion UI hidden once compiled */}
        {activeTab === 'compiler' && isCompiled && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                onClick={() => setIsCompiled(false)}
                className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-full bg-[#F3F4EE] border border-black/10 hover:bg-white text-[#121411] cursor-pointer"
              >
                ← Edit Raw Guidelines
              </button>
              {!isExtractingGuideline && (
                <button
                  onClick={handleClearVault}
                  className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-full bg-transparent border border-black/15 hover:border-[#B4463F] hover:text-[#B4463F] text-[#5E6759] cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Clear Extracted Guidelines
                </button>
              )}
            </div>
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
                {brandVault.colors.length === 0 && (
                  <p className="text-xs text-[#5E6759]">
                    No colors detected. Click '+ Add Hex' to manually define the palette.
                  </p>
                )}
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

              {/* Human-in-the-loop mark selection: the extractor's shortlist stays on
                  screen until a reviewer confirms one or declares there is none. */}
              {logoChoicePending && (
                <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                  <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                    <div>
                      <h3 className="text-sm font-semibold tracking-tight">Select Primary Brand Mark</h3>
                      <p className="mt-1 text-[11px] text-[#5E6759] max-w-xl leading-relaxed">
                        {logoCandidates.length > 0
                          ? `We shortlisted ${logoCandidates.length} high-contrast regions from the deck. Pick the one that is the real brand mark — the audit compares every banner against it. If the deck only has product imagery, upload the mark yourself or skip.`
                          : 'No isolated logos detected in document. Upload the official mark, or skip the logo check and audit without a reference lockup.'}
                      </p>
                    </div>
                  </div>
                  {logoCandidates.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {logoCandidates.map((candidate, index) => (
                      <button
                        key={`${candidate.box?.x || 0}-${candidate.box?.y || 0}-${index}`}
                        onClick={() => handleSelectLogo(candidate)}
                        className="group text-left rounded-2xl border border-black/10 bg-white p-2 hover:border-[#121411] transition cursor-pointer"
                      >
                        <div className="h-24 flex items-center justify-center overflow-hidden">
                          {candidate.referenceDataUrl ? (
                            <img
                              src={candidate.referenceDataUrl}
                              alt={`Brand mark candidate ${index + 1}`}
                              className="max-h-24 max-w-full object-contain"
                            />
                          ) : (
                            <span className="text-[11px] text-[#5E6759]">No preview</span>
                          )}
                        </div>
                        <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-[#5E6759]">
                          <span>
                            #{index + 1} · {candidate.logoType === 'wordmark' ? 'Wordmark' : 'Emblem'}
                          </span>
                          <span>{candidate.aspectRatio}:1</span>
                        </div>
                        <span className="mt-1 inline-block text-[11px] font-semibold text-[#121411] group-hover:underline">
                          Use this mark
                        </span>
                      </button>
                    ))}
                  </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-full bg-[#121411] hover:bg-[#22261f] text-[#D8FF4B] cursor-pointer">
                      <Upload className="w-3.5 h-3.5" /> Upload Logo Manually (Fallback)
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleManualLogoUpload}
                        className="hidden"
                      />
                    </label>
                    <button
                      onClick={handleSkipLogo}
                      className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-full bg-transparent border border-black/15 hover:border-[#B4463F] hover:text-[#B4463F] text-[#5E6759] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />{' '}
                      {logoCandidates.length > 0 ? 'No Logo Present / Skip' : 'Skip Logo Check'}
                    </button>
                  </div>
                </div>
              )}

              {/* Compiled Logo Lockup & Usage Conditions — held back only while the
                  shortlist above is still waiting on a human decision. */}
              {!logoChoicePending && (brandVault.logoSpec || brandVault.logoConditions) && (
                <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold tracking-tight">Compiled Logo Lockup & Usage Conditions</h3>
                    <span className="text-[10px] uppercase tracking-wider text-[#5E6759]">
                      {brandVault.logoSpec?.page ? `Source · Page ${brandVault.logoSpec.page}` : 'Text-only rules'}
                    </span>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-4">
                    {brandVault.logoSpec?.src || brandVault.logoSpec?.referenceDataUrl ? (
                      <div className="shrink-0">
                        <div className="w-32 h-32 rounded-2xl bg-white border border-black/10 flex items-center justify-center p-2 overflow-hidden">
                          <img
                            src={brandVault.logoSpec.src || brandVault.logoSpec.referenceDataUrl}
                            alt={`${brandVault.brandName || 'Brand'} reference logo`}
                            className="max-w-full max-h-full object-contain"
                          />
                        </div>
                        <p className="mt-2 text-[11px] text-[#5E6759]">
                          Aspect{' '}
                          <span className="font-mono text-[#141712]">{brandVault.logoSpec.aspectRatio}:1</span>
                        </p>
                      </div>
                    ) : (
                      // A deck with no clean emblem gets a vector monogram, never a
                      // crop of the nearest paragraph.
                      <div className="shrink-0 w-32 h-32 rounded-2xl bg-[#121411] text-[#D8FF4B] flex flex-col items-center justify-center gap-1">
                        <span className="text-3xl font-semibold tracking-tight">
                          {(brandVault.brandName || brandVault.sourceName || 'Brand')
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((word) => word[0].toUpperCase())
                            .join('')}
                        </span>
                        <span className="text-[9px] uppercase tracking-[0.2em] text-[#D8FF4B]/60">
                          Brand Mark
                        </span>
                      </div>
                    )}
                    <div className="flex-1 space-y-3">
                      {brandVault.logoSpec?.logoColors?.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="text-[#5E6759]">Allowed logo colours:</span>
                          {brandVault.logoSpec.logoColors.map((hex) => (
                            <span
                              key={hex}
                              className="flex items-center gap-1 bg-[#E7E9E0] border border-black/10 px-2 py-0.5 rounded-full font-mono"
                            >
                              <span className="w-3 h-3 rounded-full border border-black/10" style={{ backgroundColor: hex }} />
                              {hex}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          brandVault.logoConditions?.forbidStretch && 'No Stretching / Distortion',
                          brandVault.logoConditions?.forbidRecolor && 'Strict Logo Color Lock',
                          brandVault.logoConditions?.forbidAngle && 'No Angled / Tilted Logo',
                          brandVault.logoConditions?.requireClearSpace &&
                            `Clear Space Frame Required${
                              brandVault.logoConditions?.clearSpaceMultiplier
                                ? ` (${brandVault.logoConditions.clearSpaceMultiplier})`
                                : ''
                            }`,
                          brandVault.logoConditions?.backgroundGrayscaleRule &&
                            `Background Grayscale: ${brandVault.logoConditions.backgroundGrayscaleRule.allowed.join(' / ')}`,
                          brandVault.logoConditions?.minSizeRule && 'Min Size Floor'
                        ]
                          .filter(Boolean)
                          .map((label) => (
                            <span
                              key={label}
                              className="text-[11px] bg-[#D8FF4B]/35 border border-[#121411]/15 text-[#121411] px-2.5 py-1 rounded-full"
                            >
                              {label}
                            </span>
                          ))}
                      </div>
                      {brandVault.logoConditions?.minSizeRule && (
                        <p className="text-[11px] text-[#2B3129]">
                          <span className="text-[#5E6759]">Minimum size:</span> {brandVault.logoConditions.minSizeRule}
                        </p>
                      )}
                      {brandVault.logoConditions?.backgroundGrayscaleRule?.deadZone && (
                        <p className="text-[11px] text-[#2B3129]">
                          <span className="text-[#5E6759]">Forbidden mid-tone:</span>{' '}
                          {brandVault.logoConditions.backgroundGrayscaleRule.deadZone[0]}%–
                          {brandVault.logoConditions.backgroundGrayscaleRule.deadZone[1]}% black
                        </p>
                      )}
                      {brandVault.logoConditions?.improperUseList?.length > 0 && (
                        <ul className="text-[11px] text-[#2B3129] space-y-0.5 list-disc pl-4">
                          {brandVault.logoConditions.improperUseList.slice(0, 5).map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}

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
          <div className={`grid grid-cols-1 gap-6 ${hasAudited ? 'lg:grid-cols-12' : ''}`}>
            <div className={`flex flex-col gap-4 ${hasAudited ? 'lg:col-span-6' : ''}`}>
              

              <div className="order-1 bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-6 flex flex-col gap-3 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                <h2 className="font-semibold text-base tracking-tight">Advertisement Copy & Creative Input</h2>
                <textarea
                  value={workingAdText}
                  onChange={(e) => {
                    setWorkingAdText(e.target.value);
                    if (!originalAdText) setOriginalAdText(e.target.value);
                  }}
                  rows={6}
                  disabled={textInputLocked}
                  placeholder={
                    vaultEmpty
                      ? 'Please ingest a brand guideline in Tab 1 before running an audit.'
                      : imagePreview
                        ? 'Text input disabled while an image is uploaded. Clear the image to enter text.'
                        : 'Paste any advertisement copy, social caption, or promotional claim to audit...'
                  }
                  className={`w-full rounded-2xl border p-3 text-sm text-[#141712] focus:outline-none ${
                    textInputLocked
                      ? 'bg-gray-100 border-black/10 opacity-50 cursor-not-allowed'
                      : 'bg-[#E7E9E0] border-black/10 focus:border-[#121411]'
                  }`}
                />

                {/* Banner Image Uploader */}
                <div className="border border-dashed border-black/15 rounded-2xl p-3 bg-[#E7E9E0]/70 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs text-[#2B3129]">
                    <ImageIcon className="w-4 h-4 text-[#5E6759]" />
                    <span>
                      {imagePreview
                        ? 'Ad Banner Loaded (OCR + WCAG Ready)'
                        : isExtractingAdBanner
                          ? 'Reading Banner Image (Please wait)...'
                          : 'Optional: Upload Ad Banner (PNG/JPG) for Visual + OCR Audit'}
                    </span>
                  </div>
                  <label
                    className={`text-xs text-[#D8FF4B] px-3.5 py-1.5 rounded-full whitespace-nowrap ${
                      hasAudited
                        ? 'bg-gray-600 opacity-50 cursor-not-allowed pointer-events-none'
                        : imageUploadLocked
                          ? 'bg-[#121411] opacity-50 cursor-not-allowed pointer-events-none'
                          : 'bg-[#121411] hover:bg-[#22261f] cursor-pointer'
                    }`}
                    title={
                      hasAudited
                        ? "Click 'Clear Audit & Start Over' to test a new advertisement"
                        : workingAdText.trim().length > 0
                          ? 'Clear the ad copy to upload a banner instead.'
                          : undefined
                    }
                  >
                    {isExtractingAdBanner ? 'Reading…' : 'Browse Image'}
                    <input
                      key={adInputKey}
                      type="file"
                      accept="image/*"
                      onChange={handleAdBannerUpload}
                      disabled={imageUploadLocked}
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
                    {imageReport?.clipAnalysis && (
                      <div
                        className={`flex items-start gap-2 rounded-2xl border px-3 py-2 text-xs leading-relaxed ${
                          imageReport.clipAnalysis.isVisualMatch
                            ? 'border-[#B7D77A] bg-[#EDF7DC] text-[#3F5A1F]'
                            : 'border-[#E4A79F] bg-[#FCE7E3] text-[#8F2D22]'
                        }`}
                      >
                        {/* A badge written by the engine already carries its own icon
                            and wording; prefixing it again produced "⚠️ CLIP Vision AI:
                            ⚠️ Vision AI…", so it is rendered as-is. */}
                        {imageReport.clipAnalysis.overrideBadge || imageReport.clipAnalysis.visionBadge ? (
                          <span className="font-semibold">
                            {imageReport.clipAnalysis.overrideBadge || imageReport.clipAnalysis.visionBadge}
                          </span>
                        ) : (
                          <>
                            <span aria-hidden="true">
                              {imageReport.clipAnalysis.isVisualMatch ? '👁️' : '⚠️'}
                            </span>
                            <span>
                              <strong className="font-semibold">CLIP Vision AI:</strong>{' '}
                              {imageReport.clipAnalysis.isVisualMatch
                                ? `${imageReport.clipAnalysis.brandSceneScore}% Brand Scene Match`
                                : 'Off-Brand Scene Detected'}
                              {/* A positive verdict is just the score: the detected
                                  scene label reads as a caveat and undercuts it. */}
                              {!imageReport.clipAnalysis.isVisualMatch && (
                                <span className="opacity-70">
                                  {` (${imageReport.clipAnalysis.topDetectedScene} · ${imageReport.clipAnalysis.topScore}%)`}
                                </span>
                              )}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {(isRunningAudit || visionTelemetry) && (
                  <div className="relative overflow-hidden rounded-[24px] bg-[#121411] text-[#F3F4EE] p-4">
                    <style>{`
                      @keyframes nsOrbit { to { transform: rotate(360deg); } }
                      @keyframes nsPulse { 0%, 100% { opacity: .35; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.08); } }
                      @keyframes nsSweep { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
                    `}</style>
                    <div className="flex items-start gap-3">
                      <div className="relative w-9 h-9 shrink-0">
                        <span
                          className="absolute inset-0 rounded-full border border-[#D8FF4B]/30"
                          style={{ animation: 'nsPulse 1.6s ease-in-out infinite' }}
                        />
                        <span className="absolute inset-0" style={{ animation: 'nsOrbit 2.4s linear infinite' }}>
                          <span className="absolute left-1/2 top-0 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-[#D8FF4B]" />
                          <span className="absolute left-0 bottom-1 w-1 h-1 rounded-full bg-[#8CE04A]" />
                          <span className="absolute right-0 bottom-1 w-1 h-1 rounded-full bg-[#38BDF8]" />
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[10px] uppercase tracking-[0.18em] text-[#D8FF4B]">Live vision telemetry</span>
                          <span className="text-[10px] font-mono text-[#F3F4EE]/60">
                            {visionTelemetry?.modelName || VISION_ENGINE_LABEL}
                          </span>
                          {visionTelemetry?.hasWebGPU && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#38BDF8]/20 text-[#7DD3FC]">WebGPU</span>
                          )}
                        </div>
                        <p className="mt-1 text-xs font-medium leading-snug">
                          {visionTelemetry?.phase === 'downloading'
                            ? `Downloading ONNX weights${visionTelemetry?.file ? ` (${visionTelemetry.file})` : ''}…`
                            : [
                                'Quantizing vision encoder into browser cache…',
                                'Scanning banner typography & logo geometry…',
                                `Cross-checking claims against ${brandVault.sourceName}…`
                              ][Math.floor(visionElapsed / 1.8) % 3]}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug text-[#F3F4EE]/55">
                          {visionTelemetry?.step || 'Orbital reasoning over the uploaded creative…'}
                        </p>
                        <div className="mt-2 h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="relative h-full rounded-full bg-gradient-to-r from-[#8CE04A] to-[#D8FF4B] transition-all duration-300"
                            style={{ width: `${Math.max(4, visionTelemetry?.percent ?? (isRunningAudit ? 12 : 0))}%` }}
                          >
                            <span
                              className="absolute inset-y-0 w-8 bg-white/35 blur-sm"
                              style={{ animation: 'nsSweep 1.8s linear infinite' }}
                            />
                          </div>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[#F3F4EE]/65">
                          <span>Time Elapsed: {visionElapsed.toFixed(1)}s</span>
                          {visionTelemetry?.etaSec ? <span>Est. Remaining: ~{visionTelemetry.etaSec}s</span> : null}
                          {visionTelemetry?.percent ? (
                            <span>
                              {visionTelemetry.percent}%
                              {visionTelemetry.totalMB ? ` · ${visionTelemetry.loadedMB} MB / ${visionTelemetry.totalMB} MB` : ''}
                            </span>
                          ) : null}
                          {visionTelemetry?.speedMBps ? <span>{visionTelemetry.speedMBps} MB/s</span> : null}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

              </div>

              {/* Run gate: directly under the engine selector, and the only control
                  visible before the first audit. */}
              <div className="order-3 bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-5 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                <p className="text-[11px] text-[#5E6759] mb-2 leading-relaxed">
                  Runs every check locally: OCR, WCAG contrast, palette distance, claim verification and the selected vision engine.
                </p>
                <button
                  onClick={handleRunAudit}
                  disabled={auditLocked}
                  className="w-full py-2.5 rounded-full bg-[#121411] hover:bg-[#22261f] font-semibold text-sm text-[#D8FF4B] transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed disabled:pointer-events-none"
                >
                  {isRunningAudit ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-[#D8FF4B]/40 border-t-[#D8FF4B] animate-spin" />
                      {adAuditProgressText || `Running Multimodal Audit (${ocrProgress}%)...`}
                    </span>
                  ) : isExtractingAdBanner ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-[#D8FF4B]/40 border-t-[#D8FF4B] animate-spin" />
                      {adAuditProgressText || 'Preparing Banner Image (Please wait)...'}
                    </span>
                  ) : !hasAuditInput ? (
                    'Paste Ad Copy or Upload a Banner First'
                  ) : (
                    'Run Pre-Flight Brand Governance Audit'
                  )}
                </button>
                {hasAudited && (
                  <button
                    onClick={handleClearAudit}
                    disabled={isRunningAudit || isExtractingAdBanner}
                    className="mt-2 w-full py-2.5 rounded-full border border-black/15 bg-transparent text-[#2B3129] hover:border-[#B4463F] hover:text-[#B4463F] font-medium text-xs transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Clear Audit &amp; Start Over
                  </button>
                )}
              </div>

              {/* Surgical Word-Level Diff Viewer */}
              {hasAudited && (
              <div className="order-4 relative overflow-hidden bg-[#121411] text-[#F3F4EE] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.18)]">
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
              )}
            </div>

            {/* Pre-audit: no score exists yet, so the panel shows a neutral, zeroed
                state rather than a green success card for a run that never happened. */}
            {!hasAudited && (
              <div className="flex flex-col gap-4">
                <div className="bg-[#F3F4EE] text-[#141712] rounded-[28px] p-6 border border-black/5 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-[#5E6759]">Campaign Progress</span>
                      <h3 className="mt-1 text-lg font-semibold tracking-tight">Awaiting Audit</h3>
                      <p className="mt-1 text-xs text-[#5E6759]">
                        Run a Pre-Flight Audit to generate compliance telemetry and trust scores.
                      </p>
                    </div>
                    <span className="w-10 h-10 rounded-full bg-black/5 text-[#5E6759] flex items-center justify-center">
                      <BarChart3 className="w-4 h-4" />
                    </span>
                  </div>
                  <div className="mt-4 h-1 w-full rounded-full bg-black/10 overflow-hidden">
                    <div className="h-full rounded-full bg-[#5E6759]/30" style={{ width: '0%' }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-[#5E6759]">
                    <span>Remediation progress</span>
                    <span>0%</span>
                  </div>
                </div>
                <TrustArcGauge
                  trustScore={0}
                  unresolvedCount={0}
                  overriddenCount={0}
                  hasAudited={false}
                  workflowStatus=""
                />
              </div>
            )}

            {/* Right Column: Explainable Findings & Surgical Actions */}
            {hasAudited && (
            <div className="lg:col-span-6 flex flex-col gap-4">
              <div
                className={`relative overflow-hidden text-[#121510] rounded-[28px] p-6 shadow-[0_12px_32px_rgba(20,24,18,0.06)] ${
                  auditAllClear
                    ? 'bg-[radial-gradient(120%_120%_at_0%_0%,#6EE7B7_0%,#34D399_55%,#ECFDF5_100%)]'
                    : 'bg-[radial-gradient(120%_120%_at_0%_0%,#D8FF4B_0%,#E4F884_55%,#F3F5EC_100%)]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-[11px] uppercase tracking-wider text-[#121510]/60">Campaign Progress</span>
                    <h3 className="mt-1 text-lg font-semibold tracking-tight">
                      {auditAllClear ? '✨ Ready for Publication' : workflowStatus}
                    </h3>
                    <p className="mt-1 text-xs text-[#121510]/70">
                      {unresolvedCount} unresolved · {Object.keys(overrides).length} overridden · score {trustScore}%
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
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
                                    overriddenCount={pendingOverrideCount}
                passedChecks={governance.passedChecks}
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
                    // No authored replacement: the reviewer supplies wording, or we
                    // delete the term. A canned token is never inserted.
                    const needsCustomInput = isPlaceholderFix(iss.suggestedFix);
                    // Is this finding authored copy the editor can actually change?
                    const editable = isEditableTextIssue(iss, workingAdText, Boolean(imagePreview));
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
                          {!editable ? (
                            <div className="text-[#5E6759] mt-1">
                              This finding lives in the artwork — it cannot be rewritten as text.
                            </div>
                          ) : needsCustomInput ? (
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
                        ) : !editable ? (
                          <div className="flex flex-wrap items-center gap-2">
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
                            <button
                              onClick={() => handleRequestOverride(iss)}
                              className="text-xs bg-[#E7E9E0] hover:bg-[#DDE0D5] text-[#121411] px-3.5 py-1.5 rounded-full cursor-pointer"
                            >
                              Request Exception Override
                            </button>
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
                              {iss.actionType === 'append-disclaimer' ? (
                                <button
                                  onClick={() => handleAppendDisclaimer(iss)}
                                  className="text-xs bg-[#D8FF4B] hover:bg-[#e6ff7a] text-[#121411] px-3.5 py-1.5 rounded-full font-semibold cursor-pointer"
                                >
                                  1-Click Append Legal Disclaimer
                                </button>
                              ) : needsCustomInput ? (
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
            )}
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
                  Sign-off is read-only for creators. Sign out and choose "Demo Manager" or "Demo Advocate" on the login screen to unlock final publication sign-off.
                </p>
              )}
              {role === 'Creator' && (
                <div className="flex items-start gap-2 text-xs text-[#8A6D1F] bg-[#E2CC62]/25 border border-[#E2CC62]/60 p-3 rounded-2xl">
                  <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    Read-only: exception approvals and rejections are restricted to a Brand Manager (Approver) or Legal / Compliance account, so a creator cannot approve their own override.
                  </span>
                </div>
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

              <div className="space-y-2 bg-[#F3F4EE] text-[#141712] rounded-[24px] p-5 border border-black/5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#5E6759]">
                    Pending Exception Requests ({pendingOverrideCount})
                  </h3>
                  {role === 'Creator' && pendingOverrideCount > 0 && (
                    <span className="text-[10px] text-[#8A6D1F]">A Brand Manager or Legal Reviewer must decide.</span>
                  )}
                </div>
                {pendingOverrideIssues.length === 0 ? (
                  <p className="text-xs text-[#5E6759]">No exception requests are waiting for a decision.</p>
                ) : (
                  pendingOverrideIssues.map((iss) => {
                    const request = overrides[iss.id] || {};
                    const flagged = iss.flaggedText || iss.offendingText || iss.explanation || 'Flagged claim';
                    return (
                      <div key={iss.id} className="bg-[#E7E9E0] border border-black/10 p-3 rounded-2xl space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-[10px] text-[#5E6759]">
                          <span className="font-mono px-2 py-0.5 rounded-full bg-white/70 border border-black/10">{iss.id}</span>
                          <span className="px-2 py-0.5 rounded-full bg-[#E2CC62]/40 border border-[#E2CC62]/60 text-[#8A6D1F]">{iss.category}</span>
                          <span>{iss.severity} severity</span>
                        </div>
                        <p className="text-xs text-[#141712]">
                          <span className="font-semibold">Flagged text: </span>"{flagged}"
                        </p>
                        <p className="text-xs text-[#2B3129] bg-white/60 border border-black/10 rounded-xl px-3 py-2">
                          <span className="font-semibold">{request.actor || 'Creator'} justification: </span>
                          {request.reason || 'No justification recorded.'}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => handleApproveOverride(iss)}
                            disabled={role === 'Creator'}
                            className="text-xs px-3 py-1.5 rounded-full bg-[#121411] text-[#D8FF4B] hover:bg-[#22261f] font-semibold cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                          >
                            ✅ Approve Exception
                          </button>
                          <button
                            onClick={() => handleRejectOverride(iss)}
                            disabled={role === 'Creator'}
                            className="text-xs px-3 py-1.5 rounded-full border border-[#B4463F]/40 text-[#B4463F] hover:bg-[#B4463F]/10 font-semibold cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                          >
                            ❌ Reject (Needs Fix)
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
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
                                      overriddenCount={pendingOverrideCount}
                  passedChecks={governance.passedChecks}
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
                              <button
                                onClick={() => handleAutoRefineRule(group)}
                                disabled={autoRefiningId === group.ruleId}
                                className="mb-2 inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/15 text-[#D8FF4B] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                {autoRefiningId === group.ruleId ? (
                                  <>
                                    <span className="w-3 h-3 rounded-full border-2 border-[#D8FF4B]/30 border-t-[#D8FF4B] animate-spin" />
                                    Drafting clarified rule…
                                  </>
                                ) : (
                                  '✨ Auto-Refine Ambiguous Rule'
                                )}
                              </button>
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
                              {(() => {
                                const canUpdateBrandRule =
                                  currentUser?.role === 'manager' ||
                                  currentUser?.role === 'legal' ||
                                  /manager|legal/i.test(currentUser?.role || role || '');
                                if (!canUpdateBrandRule) {
                                  return (
                                    <span className="inline-flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-full font-medium whitespace-nowrap bg-white/10 text-[#F3F4EE]/40 cursor-not-allowed">
                                      Requires Manager Approval
                                    </span>
                                  );
                                }
                                return (
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
                                );
                              })()}
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

        {/* TAB 5: CONFIDENTIALITY & BRAND GOVERNANCE CERTIFICATE */}
        {activeTab === 'receipt' && (
          <div className="max-w-2xl w-full mx-auto">
            <div className="bg-[#F3F4EE] text-[#141712] border border-black/5 rounded-[28px] p-8 space-y-5 shadow-[0_12px_32px_rgba(20,24,18,0.06)]">
              <div className="flex flex-col items-center gap-3 text-[#121411] text-center">
                <div className="w-10 h-10 rounded-full bg-[#121510] text-[#D8FF4B] flex items-center justify-center">
                  <Lock className="w-4 h-4" />
                </div>
                <h2 className="font-semibold text-lg tracking-tight">Confidentiality & Brand Governance Certificate</h2>
                <p className="max-w-md text-[11px] text-[#5E6759]">
                  Sign it, seal it with a real SHA-256 fingerprint and download a formatted A4 PDF for legal or client records — no JSON reading required.
                </p>
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

              {/* Signer identity + live cryptographic seal */}
              <div className="rounded-[24px] bg-[#E7E9E0] border border-black/10 p-4 space-y-4">
                <div className="flex items-center gap-3">
                  <span className="w-11 h-11 shrink-0 rounded-full bg-[#121411] text-[#D8FF4B] border-2 border-[#D8FF4B] flex items-center justify-center text-[11px] font-bold">
                    [{signerInitials}]
                  </span>
                  <div className="flex-1 min-w-0">
                    <label
                      htmlFor="certificate-signer"
                      className="block text-[11px] font-semibold uppercase tracking-wider text-[#5E6759]"
                    >
                      Authorized Signer Name
                    </label>
                    <input
                      id="certificate-signer"
                      value={signerName}
                      onChange={(e) => setSignerName(e.target.value)}
                      placeholder="Name printed on the certificate"
                      className="mt-1 w-full rounded-xl bg-white border border-black/10 px-3 py-2 text-sm font-semibold text-[#141712] focus:border-[#121411] focus:outline-none"
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5E6759]">
                      Web Crypto SHA-256 Asset & Audit Seal
                    </span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        assetSeal ? 'bg-[#121411] text-[#D8FF4B]' : 'bg-black/10 text-[#5E6759]'
                      }`}
                    >
                      {assetSeal ? 'VERIFIED' : assetSealSupported ? 'COMPUTING…' : 'UNAVAILABLE'}
                    </span>
                  </div>
                  <code className="mt-1.5 block break-all rounded-xl bg-[#121411] text-[#D8FF4B] px-3 py-2 font-mono text-[10px] leading-relaxed">
                    {assetSeal || '·'.repeat(64)}
                  </code>
                  <p className="mt-1.5 text-[10px] text-[#5E6759]">
                    SHA-256 of brand source, audited copy, trust score, active role and signer name — recomputed in this tab on every edit.
                  </p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={downloadComplianceCertificatePDF}
                  className="flex-1 py-3 rounded-full bg-[#121411] hover:bg-[#22261f] text-xs font-semibold text-[#D8FF4B] cursor-pointer"
                >
                  Download Signed PDF Certificate (.pdf)
                </button>
                <button
                  onClick={() => {
                    const receipt = {
                      platform: 'NoSlop.com by Team Kaizen (Satyam)',
                      timestamp: new Date().toISOString(),
                      guidelineSource: brandVault.sourceName,
                      trustScore,
                      workflowStatus,
                      unresolvedFlags: unresolvedCount,
                      approvedOverrides: Object.entries(overrides).map(([issueId, override]) => ({
                        issueId,
                        ...override
                      })),
                      signerName,
                      signerRole: role,
                      sha256AssetSeal: assetSeal,
                      auditedCopy: workingAdText,
                      disclosedEngines: ['pdfjs-dist', 'tesseract.js WASM', 'transformers.js WASM (flan-t5-small + MiniLM-L6-v2, on-device)', 'compromise NLP', 'fuse.js', 'HTML5 Canvas WCAG 2.1', 'Web Crypto SHA-256'],
                      cloudDataLeakage: '0 bytes (100% Client-Side Execution)'
                    };
                    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'NoSlop_Governance_Receipt.json';
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                  }}
                  className="py-3 px-5 rounded-full bg-[#E7E9E0] border border-black/10 hover:bg-white text-xs font-semibold text-[#121411] cursor-pointer whitespace-nowrap"
                >
                  Export Raw Audit Log (.json)
                </button>
              </div>
              {certificateStatus && (
                <p className="text-[11px] text-center text-[#5E6759]" role="status">
                  {certificateStatus}
                </p>
              )}
            </div>
          </div>
        )}
        </>
        )}
      </main>
    </div>
  );
}