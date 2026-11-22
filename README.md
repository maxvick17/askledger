# AskLedger — Plain-English Small-Business Money Answers

Ask a money question in plain English — *"How many candles do I need to sell to break even?"* — and get the answer with the working shown, step by step, plus a plain-English explanation of what the number means.

Built for **SLAY HACKS 2026** (Devpost). Original code, MIT licensed.

## Try it

No build step, no server, no accounts. Either:

- Open `index.html` in any modern browser, or
- Serve the folder: `python3 -m http.server` and visit `http://localhost:8000`, or
- Use the live demo link in the Devpost submission (GitHub Pages).

## What it answers

- **Break-even units & revenue** — "I sell candles for $24 each. Each candle costs me $9 to make. My rent and other fixed costs are $2,700 a month. How many candles do I need to sell to break even?"
- **Profit-goal units** — "…and I want $3,000 profit. How many do I need to sell?"
- **Cash runway** — "I have $18,000 in the bank and I spend $3,000 a month more than I make. How long is my runway?"
- **Price from markup** — "My product costs $40 to make. What price gives me a 60% markup?"
- **Price from margin** — "What should I charge if a jacket costs me $55 and I want a 45% margin?"
- **Margin explainer** — "What's my margin if I sell a course for $200 that costs $50 to deliver?"

If a question is missing a figure, AskLedger says exactly what it needs instead of guessing — and a guided form version of every calculator is built in as a fallback.

## How the AI works

AskLedger's intelligence is a **hand-built symbolic natural-language engine in vanilla JavaScript** (`app.js`) — no external model APIs, no keys, nothing leaves the device:

1. **Intent classification** — weighted keyword/phrase scoring decides which financial model the question is about.
2. **Entity extraction & role assignment** — money amounts and percentages are located, then each amount is assigned a semantic role (price, unit cost, fixed costs, cash, burn, target profit) from the words around it, with phrase-level overrides for common phrasings ("costs me $9 to make", "$12 muffins", "$2.7k").
3. **Exact financial models** — textbook formulas: contribution margin, break-even, runway, markup↔margin conversions. Unit counts always round *up* — you can't sell 0.14 of a candle.
4. **Explanation generation** — the result is rendered as a headline answer, the step-by-step working, a "what this means" paragraph, and a sensitivity tip (e.g. what a 10% price rise does to the target).

## Files

| File | Purpose |
|---|---|
| `index.html` | The app page (question box, example chips, results, guided forms) |
| `styles.css` | Navy-and-gold styling, responsive |
| `app.js` | NLP engine + financial models + UI wiring |
| `tests/validate.js` | Headless validation suite (Node) |
| `SUBMISSION.md` | Paste-ready Devpost submission text |
| `DEMO_SCRIPT.md` | Timed script for the demo video |

## Validate

```bash
node tests/validate.js
```

17 checks: the five financial models against hand-computed values, eight realistic plain-English questions parsed end-to-end (including `$k` shorthand and $-before-product phrasing), and the missing-information path.

## Privacy & honesty notes

- 100% client-side: no analytics, no tracking, no network calls.
- AskLedger is an educational calculator, **not financial advice**; figures are estimates from the numbers provided.
- The app was developed with the help of an AI coding assistant; all logic was reviewed and is validated by the test suite above.

## License

MIT — see `LICENSE`.
