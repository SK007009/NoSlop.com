# NoSlop.com — Round 2 Architecture (Team Kaizen - Satyam)
- Stack: Vite + React + Tailwind v4 (`@tailwindcss/vite`), `pdfjs-dist`, `tesseract.js`, `compromise`, `fuse.js`, `diff`, `lucide-react`.
- Core files already working:
  1. `src/utils/guidelineParser.js`: Extracts hex colors, prohibited words, replacement rules, and numeric facts from ANY uploaded PDF or raw text.
  2. `src/utils/auditEngine.js`: Audits any random advertisement text and banner image against the compiled Brand Vault.
  3. `src/App.jsx`: 4-tab SaaS workspace.
- CRITICAL RULE: Never introduce paid cloud API keys (no OpenAI/Gemini API calls). Keep 100% client-side execution. Never break existing imports in `guidelineParser.js` or `auditEngine.js`.