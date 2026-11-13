/**
 * Regulated-claim triggers and the fine print each one obliges.
 *
 * A claim like "zero emissions" or "0% APR" is not a tone problem — it is a legal
 * disclosure problem. These rules are the built-in FTC / EPA / QSR / FinTech floor,
 * and a brand deck can tighten them (a PDF that prints its own EPA footnote is
 * attached to the matching rule by `collectRegulatoryRules`).
 *
 * The table is plain data (strings and arrays) so it can live inside the Brand Vault
 * and survive JSON export.
 */

export const DISCLAIMER_PATTERN =
  /\*|before cooking|epa[\s-]estimated|terms and conditions|restrictions apply|subject to|varies by/i;

export const REGULATORY_RULES = [
  {
    id: 'REG-ENV-1',
    name: 'Sustainability & Environmental Claim',
    standard: 'FTC Green Guides (16 CFR 260)',
    trigger: '\\b(zero[\\s-]emissions?|sustainable|eco[\\s-]friendly|100%\\s+clean|carbon[\\s-]neutral|green)\\b',
    keywords: ['emissions', 'sustainable', 'eco', 'carbon', 'green'],
    // A hydrogen plant and an electric car both say "green": the footnote has to be
    // about lifecycle emissions, not about driving range.
    requiredFinePrint:
      'Lifecycle emissions and sustainability metrics depend on grid source and operational factors.',
    citation: 'FTC Green Guides (16 CFR 260)'
  },
  {
    id: 'REG-EV-1',
    name: 'EV Range & Mileage Claim',
    standard: 'EPA range labelling',
    trigger: '\\b(miles?[\\s-]range|epa[\\s-]estimated)\\b',
    keywords: ['range', 'miles', 'epa', 'vehicle'],
    requiredFinePrint: 'EPA-estimated range. Actual range varies with conditions.',
    citation: 'EPA Range Labelling Standard'
  },
  {
    id: 'REG-QSR-1',
    name: 'Food Weight Disclosure',
    standard: 'FDA / QSR pre-cooked weight practice',
    // Only an actual weight measurement of food obliges the pre-cooked footnote:
    // a "free" app upgrade or an "offer" headline is not a quarter-pounder.
    trigger:
      '\\b(\\d+(\\.\\d+)?\\s*(oz|lb|lbs|pound|grams)\\s+(of\\s+)?(beef|meat|patty|burger)|quarter[\\s-]pound(er)?|third[\\s-]pound(er)?|pre[\\s-]cooked\\s+weight)\\b',
    keywords: ['weight', 'ounce', 'cooking', 'beef', 'pre-cooked'],
    requiredFinePrint:
      '*Weight before cooking. Participation and offer terms may vary by location.',
    citation: 'FDA / QSR Pre-Cooked Weight & Promotional Terms Standard'
  },
  {
    id: 'REG-PROMO-1',
    name: 'Promotional Offer & Subscription Terms',
    standard: 'FTC Promotional Offer & Subscription Standard',
    trigger: '\\b(free\\s+forever|zero\\s+ads|free\\s+trial|no\\s+cost)\\b',
    keywords: ['offer', 'trial', 'subscription', 'ads'],
    requiredFinePrint:
      'Offer terms and eligibility restrictions apply. Subscription auto-renews unless cancelled.',
    citation: 'FTC Promotional Offer & Subscription Standard'
  },
  {
    id: 'REG-FIN-1',
    name: 'Financial, Pricing, SLA & Guarantee Terms',
    standard: 'FinTech & SaaS advertising standard (APR / SLA disclosure)',
    // Actual financial terms only: a product "guaranteed" to work is not a loan, so
    // it must never inherit "Subject to credit approval".
    trigger:
      '\\b(\\d+(\\.\\d+)?%\\s*apr|zero\\s+interest|0%\\s*apr|no\\s+credit\\s+check|guaranteed\\s+(returns?|yield|approval))\\b',
    keywords: ['apr', 'credit', 'sla', 'terms', 'guarantee', 'approval'],
    requiredFinePrint:
      '*Subject to credit approval and service terms. Restrictions apply.',
    citation: 'FinTech & SaaS Advertising Standard (APR / SLA Disclosure)'
  }
];

// Which sentence of the brand deck, if any, states this requirement itself.
const GUIDELINE_HINTS = {
  'REG-ENV-1': /\b(emissions?|carbon|sustainab|green)/i,
  'REG-EV-1': /\b(epa|miles?\s+range|range labelling)/i,
  'REG-QSR-1': /\b(before cooking|pre-cooked|weight|ounce|promotional terms|offer terms)/i,
  'REG-PROMO-1': /\b(offer terms|subscription|free trial|auto-renew)/i,
  'REG-FIN-1': /\b(apr|credit approval|service terms|sla|guarantee terms)\b/i
};

/**
 * True when the creative already carries a footnote-style disclosure. A single
 * asterisk footnote, an EPA range note or an offer-terms line satisfies the
 * disclosure obligation for the run.
 */
export function hasDisclaimerFinePrint(text) {
  return DISCLAIMER_PATTERN.test(String(text || ''));
}

/**
 * The built-in rules, annotated with the brand deck's own wording when the deck
 * states the requirement (so the citation can point at the brand book, not just the
 * regulator).
 */
export function collectRegulatoryRules(rawText) {
  const text = String(rawText || '');
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 12);

  return REGULATORY_RULES.map((rule) => {
    const hint = GUIDELINE_HINTS[rule.id];
    const requirement = hint ? sentences.find((line) => hint.test(line)) : '';
    return requirement ? { ...rule, guidelineRequirement: requirement.slice(0, 180) } : { ...rule };
  });
}
