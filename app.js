/*
 * AskLedger — Plain-English Small-Business Money Answers
 * --------------------------------------------------------
 * A fully client-side natural-language finance assistant.
 *
 * The "AI" in AskLedger is a hand-built symbolic NLP engine written in
 * vanilla JavaScript:
 *   1. Intent classification  — scores the question against weighted
 *      keyword/phrase patterns to decide which financial model applies.
 *   2. Entity extraction      — finds money amounts and percentages and
 *      assigns each one a semantic role (price, unit cost, fixed costs,
 *      cash on hand, monthly burn, target profit...) by examining the
 *      words around it.
 *   3. Financial modelling    — exact, textbook formulas (no guessing).
 *   4. Explanation generation — turns the numbers into a plain-English
 *      answer with the working shown step by step.
 *
 * No backend, no API keys, no accounts, no external models. Everything
 * runs in the visitor's browser and no data ever leaves the device.
 *
 * The pure functions (parseQuestion, the compute* functions) are also
 * exported for Node so tests/validate.js can exercise them headlessly.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Money / number helpers                                              */
/* ------------------------------------------------------------------ */

function fmtMoney(n) {
  if (!isFinite(n)) return '—';
  var neg = n < 0;
  var v = Math.abs(n);
  var s = v >= 100
    ? Math.round(v).toLocaleString('en-US')
    : (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '-$' : '$') + s;
}

function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

function fmtPct(x) { // x is a fraction, e.g. 0.375 -> "37.5%"
  var p = Math.round(x * 1000) / 10;
  return (p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)) + '%';
}

/* ------------------------------------------------------------------ */
/* Entity extraction                                                   */
/* ------------------------------------------------------------------ */

/*
 * Find every money amount in the text. Returns tokens:
 * { value, index, raw } where index is the word position in the
 * tokenised sentence (used for context-window role assignment).
 * Handles: $1,800 · 1800 dollars · $2.7k · 3 thousand · $1.2 million
 */
function extractMoney(words) {
  var tokens = [];
  var i, w, m, val;
  for (i = 0; i < words.length; i++) {
    w = words[i];
    // A word like "$1,800" or "1800" or "$24.50"
    m = w.match(/^\$?(\d[\d,]*(?:\.\d+)?)$/);
    if (m) {
      val = parseFloat(m[1].replace(/,/g, ''));
      // Suffix multipliers in the following word: k / thousand / million / grand
      var next = (words[i + 1] || '').replace(/[^a-z]/g, '');
      if (next === 'k' || next === 'grand' || next === 'thousand') val *= 1000;
      else if (next === 'million') val *= 1000000;
      tokens.push({ value: val, wordIndex: i, raw: w });
      continue;
    }
    // A word like "$2.7k"
    m = w.match(/^\$(\d[\d,]*(?:\.\d+)?)k$/);
    if (m) {
      tokens.push({ value: parseFloat(m[1].replace(/,/g, '')) * 1000, wordIndex: i, raw: w });
    }
  }
  return tokens;
}

function extractPercents(text) {
  var out = [];
  var re = /(\d+(?:\.\d+)?)\s*(?:%|percent)/g, m;
  while ((m = re.exec(text)) !== null) out.push(parseFloat(m[1]) / 100);
  return out;
}

/* Role dictionaries: words that signal what a nearby amount MEANS. */
var ROLE_CUES = {
  price: ['sell', 'sells', 'selling', 'sold', 'charge', 'charging', 'price', 'priced', 'for', 'at', 'goes'],
  unitCost: ['costs', 'cost', 'make', 'making', 'materials', 'produce', 'deliver', 'spend'],
  fixedCosts: ['rent', 'fixed', 'overhead', 'monthly', 'cover', 'expenses', 'bills', 'lease', 'payroll', 'insurance'],
  cash: ['have', 'saved', 'savings', 'bank', 'cash', 'reserve', 'reserves', 'left'],
  burn: ['burn', 'spend', 'spending', 'lose', 'losing', 'shortfall', 'more'],
  revenue: ['revenue', 'sales', 'bring', 'income', 'earn', 'earning', 'make'],
  targetProfit: ['profit', 'goal', 'target', 'want', 'earn', 'make', 'clear']
};

/*
 * Assign a semantic role to each money token by scoring cue words in a
 * window around it, with phrase-level overrides for the most common
 * ways people actually phrase these questions.
 */
function assignRoles(text, words, tokens) {
  var lower = text.toLowerCase();
  tokens.forEach(function (tok) {
    var start = Math.max(0, tok.wordIndex - 7);
    var end = Math.min(words.length, tok.wordIndex + 6);
    var window = words.slice(start, end).join(' ');
    var scores = {};
    Object.keys(ROLE_CUES).forEach(function (role) {
      scores[role] = 0;
      ROLE_CUES[role].forEach(function (cue) {
        if (window.indexOf(cue) !== -1) scores[role] += 1;
      });
    });

    /* Phrase overrides — strong, specific signals. before/after are
       space-padded so "cue at the edge" patterns match reliably. */
    var before = ' ' + words.slice(Math.max(0, tok.wordIndex - 5), tok.wordIndex).join(' ') + ' ';
    var after = ' ' + words.slice(tok.wordIndex + 1, tok.wordIndex + 5).join(' ') + ' ';
    var near = before + '#' + tok.raw + after;

    if (/costs?\s+(me\s+)?$/.test(before) || /each\s+\w+\s+costs?$/.test(before) ||
        /costs?\s+.*to\s+(make|produce|deliver)/.test(near) || /to\s+make/.test(after) ||
        /cost\s+per/.test(near) || /per\s+unit/.test(near)) {
      scores.unitCost += 6;
    }
    if (/sell(s|ing)?\s+(for|at)\s+$/.test(before) || /for\s+$/.test(before) ||
        /price\s+(is|of)?\s*$/.test(before) || /charge\s+$/.test(before) ||
        /at\s+$/.test(before) || /each\s+for/.test(before)) {
      scores.price += 6;
    }
    if (/rent/.test(window) || /fixed\s+costs?/.test(window) || /monthly\s+costs?/.test(window) ||
        /cover\s+$/.test(before) || /overhead/.test(window)) {
      scores.fixedCosts += 6;
    }
    if (/have\s+$/.test(before) || /in\s+the\s+bank/.test(after) || /saved\s+$/.test(before) ||
        /cash\s+of\s+$/.test(before) || /\$\S+\s+in\s+(the\s+)?bank/.test(lower)) {
      scores.cash += 6;
    }
    if (/spend(s|ing)?\s+$/.test(before) || /burn\s+(rate\s+)?(is\s+)?(of\s+)?$/.test(before) ||
        /a\s+month\s+more/.test(after) || /more\s+than\s+i\s+make/.test(after)) {
      scores.burn += 6;
    }
    if (/profit\s+(of\s+)?$/.test(before) || /make\s+$/.test(before) && /profit/.test(after) ||
        /want\s+(a\s+)?\$/.test(near) || /profit/.test(after) && /(want|goal|target)/.test(before)) {
      scores.targetProfit += 6;
    }
    if (/(revenue|sales)\s+(of\s+)?$/.test(before) || /bring\s+in\s+$/.test(before)) {
      scores.revenue += 6;
    }

    var best = null, bestScore = 0;
    Object.keys(scores).forEach(function (role) {
      if (scores[role] > bestScore) { bestScore = scores[role]; best = role; }
    });
    tok.role = bestScore > 0 ? best : 'unknown';
    tok.roleScore = bestScore;
  });
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Financial models (exact formulas)                                   */
/* ------------------------------------------------------------------ */

function computeBreakeven(fixedCosts, price, unitCost, targetProfit) {
  var contribution = price - unitCost;
  if (contribution <= 0) {
    return { error: 'Each sale loses money: the price (' + fmtMoney(price) + ') does not cover the per-unit cost (' + fmtMoney(unitCost) + '). Raise the price or cut the unit cost before break-even is possible.' };
  }
  var goal = fixedCosts + (targetProfit || 0);
  var unitsExact = goal / contribution;
  var units = Math.ceil(unitsExact);
  return {
    contribution: contribution,
    unitsExact: unitsExact,
    units: units,
    revenue: units * price,
    targetProfit: targetProfit || 0
  };
}

function computeRunway(cash, monthlyBurn) {
  if (monthlyBurn <= 0) {
    return { error: 'A runway only runs out if you are spending more than you bring in. With no monthly shortfall, the cash does not deplete on this path.' };
  }
  return { months: cash / monthlyBurn, monthsWhole: Math.floor(cash / monthlyBurn) };
}

function computePriceFromMarkup(cost, markup) {
  return { price: cost * (1 + markup), margin: markup / (1 + markup) };
}

function computePriceFromMargin(cost, margin) {
  if (margin >= 1) return { error: 'A margin of 100% or more is impossible — it would require an infinite price. Margins are always below 100%.' };
  var price = cost / (1 - margin);
  return { price: price, markup: (price - cost) / cost };
}

function computeMarginInfo(price, cost) {
  if (price <= 0) return { error: 'A selling price is needed to work out the margin.' };
  return { margin: (price - cost) / price, markup: cost > 0 ? (price - cost) / cost : Infinity, profitPerUnit: price - cost };
}

/* ------------------------------------------------------------------ */
/* Intent classification                                               */
/* ------------------------------------------------------------------ */

function classifyIntent(lower) {
  var scores = { breakeven: 0, runway: 0, markupPrice: 0, marginPrice: 0, marginInfo: 0 };
  if (/break.?even/.test(lower)) scores.breakeven += 5;
  if (/cover\s+(my\s+)?(costs|rent|expenses|bills|overhead)/.test(lower)) scores.breakeven += 4;
  if (/how\s+many/.test(lower) && /sell/.test(lower)) scores.breakeven += 4;
  if (/need\s+to\s+sell/.test(lower)) scores.breakeven += 3;
  if (/runway/.test(lower)) scores.runway += 6;
  if (/how\s+long/.test(lower) && /(last|run\s+out|deplete)/.test(lower)) scores.runway += 4;
  if (/before\s+(the\s+)?(money|cash)\s+runs?\s+out/.test(lower)) scores.runway += 4;
  if (/markup/.test(lower)) scores.markupPrice += 5;
  if (/margin/.test(lower) && /(charge|price|sell|set|want|need|aim|hit|get)/.test(lower) && !/what('?s| is)\s+my\s+margin/.test(lower)) scores.marginPrice += 5;
  if (/what('?s| is)\s+my\s+margin/.test(lower) || (/margin/.test(lower) && /(sell|sold|selling)/.test(lower) && /(cost|costs)/.test(lower) && !/want|aim|hit|target/.test(lower))) scores.marginInfo += 5;
  if (/what\s+(should|do)\s+i\s+charge/.test(lower)) { scores.markupPrice += 2; scores.marginPrice += 2; }
  var best = 'breakeven', bestScore = -1;
  Object.keys(scores).forEach(function (k) { if (scores[k] > bestScore) { bestScore = scores[k]; best = k; } });
  return { intent: best, score: bestScore };
}

/* ------------------------------------------------------------------ */
/* The parser: question -> structured answer                           */
/* ------------------------------------------------------------------ */

function parseQuestion(rawText) {
  var text = ' ' + rawText.trim().replace(/\s+/g, ' ') + ' ';
  var lower = text.toLowerCase();
  var words = lower.replace(/,/g, '').split(/\s+/).filter(Boolean);
  var tokens = assignRoles(lower, words, extractMoney(words));
  var percents = extractPercents(lower);
  var cls = classifyIntent(lower);

  function byRole(role) {
    var t = tokens.filter(function (x) { return x.role === role; });
    return t.length ? t[0].value : null;
  }
  function unknowns() { return tokens.filter(function (x) { return x.role === 'unknown'; }); }

  var found = {};
  tokens.forEach(function (t) { if (t.role !== 'unknown' && found[t.role] === undefined) found[t.role] = t.value; });

  /* ---- Runway ---------------------------------------------------- */
  if (cls.intent === 'runway') {
    var cash = byRole('cash');
    var burn = byRole('burn');
    if (cash === null && tokens.length) cash = tokens[0].value;
    if (burn === null) {
      var rest = tokens.filter(function (t) { return t.value !== cash; });
      if (rest.length) burn = rest[0].value;
    }
    if (cash === null || burn === null) {
      return missing('runway', found, ['cash on hand (e.g. "$18,000 in the bank")', 'monthly shortfall (e.g. "I spend $3,000 a month more than I make")'], cash === null, burn === null);
    }
    var r = computeRunway(cash, burn);
    if (r.error) return { ok: false, error: r.error, found: found };
    return {
      ok: true, intent: 'runway', found: found,
      headline: 'About ' + (Math.round(r.months * 10) / 10) + ' months of runway',
      steps: [
        'Cash on hand: ' + fmtMoney(cash),
        'Monthly shortfall (spending minus income): ' + fmtMoney(burn),
        'Runway = ' + fmtMoney(cash) + ' ÷ ' + fmtMoney(burn) + ' per month = ' + (Math.round(r.months * 100) / 100) + ' months'
      ],
      explanation: 'At the current pace, the money lasts roughly ' + r.monthsWhole + ' full months' +
        (r.months - r.monthsWhole >= 0.25 ? ' and part of the next one' : '') +
        '. Every ' + fmtMoney(burn / 10) + ' trimmed from the monthly shortfall buys about ' +
        (Math.round((cash / (burn * 0.9) - r.months) * 10) / 10) + ' extra months if you cut spending by 10%.',
      tip: 'Try it: cut the monthly shortfall by 10% (to ' + fmtMoney(burn * 0.9) + ') and the runway stretches to about ' + (Math.round(cash / (burn * 0.9) * 10) / 10) + ' months.'
    };
  }

  /* ---- Price from markup ----------------------------------------- */
  if (cls.intent === 'markupPrice' && percents.length) {
    var costM = byRole('unitCost') !== null ? byRole('unitCost') : (tokens.length ? tokens[0].value : null);
    if (costM === null) return missing('markup', found, ['the cost to make one unit (e.g. "costs $40 to make")', 'the markup percentage'], true, false);
    var mk = computePriceFromMarkup(costM, percents[0]);
    return {
      ok: true, intent: 'markupPrice', found: found,
      headline: 'Charge ' + fmtMoney(mk.price),
      steps: [
        'Cost per unit: ' + fmtMoney(costM),
        'Markup: ' + fmtPct(percents[0]),
        'Price = ' + fmtMoney(costM) + ' × (1 + ' + percents[0] + ') = ' + fmtMoney(mk.price)
      ],
      explanation: 'A ' + fmtPct(percents[0]) + ' markup on a ' + fmtMoney(costM) + ' cost means adding ' + fmtMoney(mk.price - costM) +
        ' to every unit. Careful: markup is not margin — at this price your profit margin is ' + fmtPct(mk.margin) +
        ' of the selling price, because margin is measured against the price, not the cost.',
      tip: 'If you actually wanted a ' + fmtPct(percents[0]) + ' margin instead, the price would need to be ' +
        fmtMoney(computePriceFromMargin(costM, percents[0]).price) + '.'
    };
  }

  /* ---- Price from margin ------------------------------------------ */
  if (cls.intent === 'marginPrice' && percents.length) {
    var costG = byRole('unitCost') !== null ? byRole('unitCost') : (tokens.length ? tokens[0].value : null);
    if (costG === null) return missing('margin', found, ['the cost to make one unit (e.g. "costs me $55")', 'the target margin percentage'], true, false);
    var mg = computePriceFromMargin(costG, percents[0]);
    if (mg.error) return { ok: false, error: mg.error, found: found };
    return {
      ok: true, intent: 'marginPrice', found: found,
      headline: 'Charge ' + fmtMoney(mg.price),
      steps: [
        'Cost per unit: ' + fmtMoney(costG),
        'Target margin: ' + fmtPct(percents[0]),
        'Price = ' + fmtMoney(costG) + ' ÷ (1 − ' + percents[0] + ') = ' + fmtMoney(mg.price)
      ],
      explanation: 'To keep ' + fmtPct(percents[0]) + ' of every sale as gross profit, the cost can only be ' +
        fmtPct(1 - percents[0]) + ' of the price — so the price is the cost divided by ' + (1 - percents[0]) +
        '. That works out to a markup of ' + fmtPct(mg.markup) + ' on cost, which is why margin and markup numbers never match.',
      tip: 'At ' + fmtMoney(mg.price) + ' you keep ' + fmtMoney(mg.price - costG) + ' of gross profit on every unit sold.'
    };
  }

  /* ---- Margin info ------------------------------------------------- */
  if (cls.intent === 'marginInfo') {
    var pI = byRole('price'), cI = byRole('unitCost');
    if (pI === null || cI === null) {
      var un = unknowns();
      if (pI === null && un.length) { pI = un[0].value; }
      if (cI === null && un.length > 1) { cI = un[1].value; }
    }
    if (pI === null || cI === null) return missing('marginInfo', found, ['the selling price (e.g. "sell for $200")', 'the cost per unit (e.g. "costs $50 to deliver")'], pI === null, cI === null);
    var mi = computeMarginInfo(pI, cI);
    if (mi.error) return { ok: false, error: mi.error, found: found };
    return {
      ok: true, intent: 'marginInfo', found: found,
      headline: 'Your margin is ' + fmtPct(mi.margin),
      steps: [
        'Selling price: ' + fmtMoney(pI) + ' · Cost: ' + fmtMoney(cI) + ' · Profit per unit: ' + fmtMoney(mi.profitPerUnit),
        'Margin = (' + fmtMoney(pI) + ' − ' + fmtMoney(cI) + ') ÷ ' + fmtMoney(pI) + ' = ' + fmtPct(mi.margin),
        'Markup = (' + fmtMoney(pI) + ' − ' + fmtMoney(cI) + ') ÷ ' + fmtMoney(cI) + ' = ' + fmtPct(mi.markup)
      ],
      explanation: 'Out of every ' + fmtMoney(pI) + ' sale, ' + fmtMoney(mi.profitPerUnit) + ' is gross profit — that is ' +
        fmtPct(mi.margin) + ' of the price. The same profit measured against the cost is a ' + fmtPct(mi.markup) +
        ' markup. Margin tells you how much of each sales dollar you keep; markup tells you how much you added on top of cost.',
      tip: 'Rule of thumb: a ' + fmtPct(mi.margin) + ' margin means costs could rise by up to ' + fmtMoney(mi.profitPerUnit) + ' per unit before this product stops making money.'
    };
  }

  /* ---- Break-even / target-profit units (default) ------------------ */
  var price = byRole('price');
  var unitCost = byRole('unitCost');
  var fixed = byRole('fixedCosts');
  var target = byRole('targetProfit');

  // Fallbacks from unassigned amounts, using question order heuristics.
  var un = unknowns();
  if (price === null && un.length) {
    // "$12 muffins ... sell" style: a price often sits right before the product noun.
    price = un[0].value; un = un.slice(1);
  }
  if (fixed === null && un.length) { fixed = un[un.length - 1].value; un = un.slice(0, -1); }
  if (unitCost === null && un.length) { unitCost = un[0].value; }

  var needPrice = price === null, needCost = unitCost === null, needFixed = fixed === null;
  if (needPrice || needCost || needFixed) {
    var labels = [];
    if (needPrice) labels.push('the selling price (e.g. "sell them for $24 each")');
    if (needCost) labels.push('the cost to make one (e.g. "each costs me $9 to make")');
    if (needFixed) labels.push('the monthly fixed costs (e.g. "rent and other fixed costs are $2,700 a month")');
    return missing(target ? 'targetProfit' : 'breakeven', found, labels, needPrice, needCost, needFixed);
  }

  var be = computeBreakeven(fixed, price, unitCost, target || 0);
  if (be.error) return { ok: false, error: be.error, found: found };

  var isTarget = !!target;
  return {
    ok: true, intent: isTarget ? 'targetProfit' : 'breakeven', found: found,
    headline: 'Sell ' + fmtNum(be.units) + ' units' + (isTarget ? ' to hit your profit goal' : ' to break even'),
    steps: [
      'Contribution per unit = price − unit cost = ' + fmtMoney(price) + ' − ' + fmtMoney(unitCost) + ' = ' + fmtMoney(be.contribution),
      (isTarget
        ? 'Amount to cover = fixed costs + target profit = ' + fmtMoney(fixed) + ' + ' + fmtMoney(target) + ' = ' + fmtMoney(fixed + target)
        : 'Amount to cover = fixed costs = ' + fmtMoney(fixed)),
      'Units = ' + fmtMoney(fixed + (target || 0)) + ' ÷ ' + fmtMoney(be.contribution) + ' = ' + (Math.round(be.unitsExact * 100) / 100) + ' → round up to ' + fmtNum(be.units),
      'That is ' + fmtMoney(be.revenue) + ' in sales' + (isTarget ? ', leaving ' + fmtMoney(target) + ' of profit after all costs' : ' — the point where costs are exactly covered')
    ],
    explanation: 'Every unit you sell puts ' + fmtMoney(be.contribution) + ' toward your fixed costs' +
      (isTarget ? ' and then your profit goal' : '') + '. Until you have sold ' + fmtNum(be.units) +
      ' units in the month, the business is still in the red; every unit after that adds ' + fmtMoney(be.contribution) +
      ' of profit. Spread over roughly 30 days, that is about ' + fmtNum(Math.ceil(be.units / 30)) + ' sales a day.',
    tip: 'Raising the price by 10% to ' + fmtMoney(price * 1.1) + ' would cut the target to ' +
      fmtNum(computeBreakeven(fixed, price * 1.1, unitCost, target || 0).units || 0) + ' units.'
  };

  function missing(intent, foundSoFar, labels, a, b, c) {
    return {
      ok: false, intent: intent, found: foundSoFar,
      error: 'I could not find everything I need. Missing: ' + labels.join('; ') + '.',
      missingLabels: labels
    };
  }
}

/* ------------------------------------------------------------------ */
/* Exports for headless validation                                     */
/* ------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseQuestion: parseQuestion,
    computeBreakeven: computeBreakeven,
    computeRunway: computeRunway,
    computePriceFromMarkup: computePriceFromMarkup,
    computePriceFromMargin: computePriceFromMargin,
    computeMarginInfo: computeMarginInfo,
    fmtMoney: fmtMoney, fmtPct: fmtPct
  };
}

/* ------------------------------------------------------------------ */
/* Browser UI (skipped under Node)                                     */
/* ------------------------------------------------------------------ */
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('ask-form');
    var input = document.getElementById('question');
    var result = document.getElementById('result');
    var chips = document.querySelectorAll('.chip');

    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        input.value = chip.getAttribute('data-q');
        form.requestSubmit();
      });
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      render(parseQuestion(q));
    });

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function render(ans) {
      result.hidden = false;
      if (!ans.ok) {
        result.innerHTML =
          '<div class="answer-card warn"><h2>Almost there</h2><p>' + esc(ans.error) + '</p>' +
          '<p class="hint">Add the missing figures to your question, or use the guided form below — it needs no special wording.</p></div>';
        result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      var steps = ans.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
      result.innerHTML =
        '<div class="answer-card">' +
        '<div class="headline">' + esc(ans.headline) + '</div>' +
        '<h3>How I worked it out</h3><ol class="steps">' + steps + '</ol>' +
        '<h3>What this means</h3><p>' + esc(ans.explanation) + '</p>' +
        '<p class="tip"><strong>Worth trying:</strong> ' + esc(ans.tip) + '</p>' +
        '</div>';
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    /* -------- Guided form (same models, no wording needed) -------- */
    var calcSelect = document.getElementById('calc-type');
    var fieldSets = document.querySelectorAll('.fieldset');
    function syncFields() {
      fieldSets.forEach(function (fs) {
        fs.hidden = fs.getAttribute('data-for') !== calcSelect.value;
      });
    }
    calcSelect.addEventListener('change', syncFields);
    syncFields();

    document.getElementById('guided-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      function num(id) { var v = parseFloat(document.getElementById(id).value); return isNaN(v) ? null : v; }
      var type = calcSelect.value, ans;
      if (type === 'breakeven') {
        var f = num('g-fixed'), p = num('g-price'), c = num('g-cost'), t = num('g-target') || 0;
        if (f === null || p === null || c === null) { render({ ok: false, error: 'Please fill in fixed costs, price, and cost per unit.' }); return; }
        var be = computeBreakeven(f, p, c, t);
        if (be.error) { render({ ok: false, error: be.error }); return; }
        ans = { ok: true, headline: 'Sell ' + fmtNum(be.units) + ' units' + (t ? ' to hit your profit goal' : ' to break even'),
          steps: ['Contribution per unit = ' + fmtMoney(p) + ' − ' + fmtMoney(c) + ' = ' + fmtMoney(be.contribution),
                  'Units = ' + fmtMoney(f + t) + ' ÷ ' + fmtMoney(be.contribution) + ' = ' + (Math.round(be.unitsExact * 100) / 100) + ' → ' + fmtNum(be.units),
                  'Sales at that point: ' + fmtMoney(be.revenue)],
          explanation: 'Each sale contributes ' + fmtMoney(be.contribution) + ' toward fixed costs' + (t ? ' and your profit goal' : '') + '.',
          tip: 'Every extra unit beyond ' + fmtNum(be.units) + ' adds ' + fmtMoney(be.contribution) + ' of profit.' };
      } else if (type === 'runway') {
        var cash = num('g-cash'), burn = num('g-burn');
        if (cash === null || burn === null) { render({ ok: false, error: 'Please fill in cash on hand and the monthly shortfall.' }); return; }
        var rw = computeRunway(cash, burn);
        if (rw.error) { render({ ok: false, error: rw.error }); return; }
        ans = { ok: true, headline: 'About ' + (Math.round(rw.months * 10) / 10) + ' months of runway',
          steps: ['Runway = ' + fmtMoney(cash) + ' ÷ ' + fmtMoney(burn) + ' = ' + (Math.round(rw.months * 100) / 100) + ' months'],
          explanation: 'That is ' + rw.monthsWhole + ' full months at the current monthly shortfall.',
          tip: 'Cutting the shortfall by 10% stretches it to about ' + (Math.round(cash / (burn * 0.9) * 10) / 10) + ' months.' };
      } else if (type === 'markup') {
        var cm = num('g-mcost'), pct = num('g-mpct');
        if (cm === null || pct === null) { render({ ok: false, error: 'Please fill in the unit cost and the markup percentage.' }); return; }
        var mk = computePriceFromMarkup(cm, pct / 100);
        ans = { ok: true, headline: 'Charge ' + fmtMoney(mk.price),
          steps: ['Price = ' + fmtMoney(cm) + ' × (1 + ' + pct / 100 + ') = ' + fmtMoney(mk.price)],
          explanation: 'That price gives you a margin of ' + fmtPct(mk.margin) + ' — markup and margin are different measures.',
          tip: 'For a ' + pct + '% margin instead, charge ' + fmtMoney(computePriceFromMargin(cm, pct / 100).price) + '.' };
      } else if (type === 'margin') {
        var cg = num('g-gcost'), pg = num('g-gpct');
        if (cg === null || pg === null) { render({ ok: false, error: 'Please fill in the unit cost and the target margin percentage.' }); return; }
        var mg = computePriceFromMargin(cg, pg / 100);
        if (mg.error) { render({ ok: false, error: mg.error }); return; }
        ans = { ok: true, headline: 'Charge ' + fmtMoney(mg.price),
          steps: ['Price = ' + fmtMoney(cg) + ' ÷ (1 − ' + pg / 100 + ') = ' + fmtMoney(mg.price)],
          explanation: 'You keep ' + fmtMoney(mg.price - cg) + ' of gross profit per unit at that price.',
          tip: 'That price is a markup of ' + fmtPct(mg.markup) + ' on cost.' };
      } else { /* margininfo */
        var pi = num('g-ip'), ci = num('g-ic');
        if (pi === null || ci === null) { render({ ok: false, error: 'Please fill in the selling price and the unit cost.' }); return; }
        var mi = computeMarginInfo(pi, ci);
        if (mi.error) { render({ ok: false, error: mi.error }); return; }
        ans = { ok: true, headline: 'Your margin is ' + fmtPct(mi.margin),
          steps: ['Profit per unit = ' + fmtMoney(pi) + ' − ' + fmtMoney(ci) + ' = ' + fmtMoney(mi.profitPerUnit),
                  'Margin = ' + fmtPct(mi.margin) + ' · Markup = ' + fmtPct(mi.markup)],
          explanation: 'Margin is your profit as a share of the price; markup is the same profit as a share of the cost.',
          tip: 'Costs could rise by ' + fmtMoney(mi.profitPerUnit) + ' per unit before this product stops making money.' };
      }
      render(ans);
    });
  });
}
