import { WIKI_SEARCH_SYNONYMS } from "@orlok/shared";

// Word search over an office wiki (R-MEM-4), ranked in the app rather than by Postgres, after the
// defects measured with `wiki:eval` on real wikis:
// - pages are ranked BM25-style, normalized by length: a page of 97,000 characters used to come
//   first for any question, just by containing every word somewhere;
// - word forms match by a 6-letter prefix ("stampanti" finds "stampante"), and in 5-6 letter words
//   the final vowel goes too ("banda" finds "bande");
// - a long identifier the prefix flattens (RequireSenderAuthenticationEnabled → "requir", which
//   finds "requirements") gets a bonus for the exact word, worth what the prefix lost;
// - IP addresses, host names, paths and codes (10.0.0.91, A100.05.9028) are searched whole, as
//   the word split would break them into pieces found everywhere;
// - terms of 2-3 letters count only as a whole word or a word ending ("at" no longer finds
//   "attivo", "ced" no longer finds "precedente");
// - synonyms (Italian and English, jargon) come in groups: a page takes the best term of each
//   group, so a synonym never counts twice.
// Pages marked superseded, retired or historical stay findable, after the current ones.

export type SearchablePage = {
  slug: string;
  title: string;
  section: string | null;
  content: string;
  // Not current any more: ranked after the current pages.
  outdated?: boolean;
};

type IndexedPage = {
  page: SearchablePage;
  words: Map<string, number>;
  size: number;
  titleWords: Set<string>;
  sectionWords: Set<string>;
  // Title and content, folded, for whole forms such as IP addresses.
  text: string;
};

export type SearchIndex = { pages: IndexedPage[]; averageSize: number };

// score: against the best page (1 for it); telling: how many words of the query that are rare in
// the office the page holds, which says whether the query found its subject at all.
export type RankedPage = { slug: string; score: number; snippet: string; telling: number };

// Frequent English and Italian words that would match almost every page. Short IT terms (AD, VPN)
// must stay out of it.
const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do for from has have how i if in is it me my no not of on or " +
    "so that the this to was what when where which who why will with you your " +
    "al alla anche che chi ci come con cosa da dal dei del della delle di dove e ed gli ha ho il " +
    "in la le lo ma mi mio mia ne nei nel nella non o per perche piu quando se si sono su sua suo " +
    "ti tra tu un una uno agli allo alle col coi dagli dai dalla dalle degli dello negli nelle " +
    "sui sul sulla sulle sugli questo questa quello quella"
  ).split(" "),
);

const PREFIX_LENGTH = 6;
// The words of a query that are read, and how many of them, the rarest, are searched: a long
// message names its subject anywhere, not only in its first words.
const MAX_QUERY_WORDS = 48;
const MAX_QUERY_TERMS = 12;
// A word on at most this share of the office's pages names a subject; the others ("fare",
// "sempre", "make", "always") are everyday words in any language. A small wiki has too few pages
// to tell them apart: there, any word on a few pages counts.
const TELLING_SHARE = 0.25;
const TELLING_MIN_PAGES = 3;
const SYNONYM_WEIGHT = 0.8;
const BM25_B = 0.75;
const BM25_K = 1.2;
const TITLE_WEIGHT = 3;
const SECTION_WEIGHT = 1;
const EXACT_WEIGHT = 4;
// Pages far below the best one (a single common word) are left out.
const MIN_RELATIVE_SCORE = 0.25;
const OUTDATED_FACTOR = 0.5;

const WORD = /[\p{L}\p{N}_]+/gu;
// Forms with dots, colons, dashes or slashes: IP addresses, host names, ports, paths, codes.
const FORM = /[\p{L}\p{N}_][\p{L}\p{N}_.:/\\-]*[\p{L}\p{N}_]/gu;

// Lowercase text without accents, so "perché" and "perche" match.
export function fold(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function wordsOf(text: string) {
  return fold(text).match(WORD) ?? [];
}

export function stem(word: string) {
  const prefix = word.slice(0, PREFIX_LENGTH);
  return prefix.length >= 5 && "aeiou".includes(prefix.at(-1) ?? "") ? prefix.slice(0, -1) : prefix;
}

function isTerm(word: string) {
  return word.length >= 2 && !STOPWORDS.has(word);
}

export function buildSearchIndex(pages: SearchablePage[]): SearchIndex {
  const indexed = pages.map((page) => {
    const words = new Map<string, number>();
    let size = 0;
    for (const word of wordsOf(page.content)) {
      words.set(word, (words.get(word) ?? 0) + 1);
      size += 1;
    }
    return {
      page,
      words,
      size,
      titleWords: new Set(wordsOf(page.title)),
      sectionWords: new Set(wordsOf(page.section ?? "")),
      text: fold(`${page.title}\n${page.content}`),
    };
  });
  const total = indexed.reduce((sum, page) => sum + page.size, 0);
  return { pages: indexed, averageSize: total / Math.max(1, indexed.length) };
}

// How well a word of the page matches a query term: 1 from the start, 0.5 inside. Short terms
// only as a whole word, or (3 letters) as a word ending: "rdp" in "freerdp".
function matchWeight(word: string, term: string) {
  if (term.length <= 3) {
    return word === term ? 1 : term.length === 3 && word.endsWith(term) ? 0.5 : 0;
  }
  return word.startsWith(term) ? 1 : word.includes(term) ? 0.5 : 0;
}

function countHits(words: Map<string, number>, term: string) {
  let hits = 0;
  for (const [word, count] of words) {
    const weight = matchWeight(word, term);
    if (weight > 0) {
      hits += count * weight;
    }
  }
  return hits;
}

function setHits(words: Set<string>, term: string) {
  let hits = 0;
  for (const word of words) {
    hits = Math.max(hits, matchWeight(word, term));
  }
  return hits;
}

type TermGroup = { term: string; weight: number }[];

function phraseWords(phrase: string) {
  return wordsOf(phrase).join(" ");
}

// The query as groups of terms. A synonym group whose phrase appears in the query brings its other
// phrases as alternatives; every other query word is a group of its own.
export function termGroups(query: string, synonyms: string[][] = WIKI_SEARCH_SYNONYMS) {
  const folded = ` ${phraseWords(query)} `;
  const groups: TermGroup[] = [];
  const used = new Set<string>();
  for (const line of synonyms) {
    const hit = line.filter((phrase) => {
      const words = phraseWords(phrase);
      return words && folded.includes(` ${words} `);
    });
    if (hit.length === 0) {
      continue;
    }
    const group = new Map<string, number>();
    for (const phrase of line) {
      const weight = hit.includes(phrase) ? 1 : SYNONYM_WEIGHT;
      for (const word of wordsOf(phrase)) {
        if (isTerm(word)) {
          const term = stem(word);
          group.set(term, Math.max(group.get(term) ?? 0, weight));
        }
      }
    }
    for (const phrase of hit) {
      for (const word of wordsOf(phrase)) {
        used.add(stem(word));
      }
    }
    groups.push([...group].map(([term, weight]) => ({ term, weight })));
  }
  for (const word of wordsOf(query)) {
    const term = stem(word);
    if (isTerm(word) && !used.has(term)) {
      used.add(term);
      groups.push([{ term, weight: 1 }]);
    }
    if (groups.length >= MAX_QUERY_WORDS) {
      break;
    }
  }
  return groups;
}

// Whole words the prefix flattens (long identifiers, words with digits), and forms the word split
// would break (IP addresses, host names, paths): these are looked for as they are.
export function exactTerms(query: string) {
  const words = [
    ...new Set(
      wordsOf(query).filter(
        (word) =>
          isTerm(word) && (word.length > PREFIX_LENGTH || (/\d/.test(word) && word.length >= 3)),
      ),
    ),
  ];
  const forms = [
    ...new Set(
      (fold(query).match(FORM) ?? []).filter((form) => /[.:/\\-]/.test(form) && form.length >= 4),
    ),
  ];
  return { words, forms };
}

function inverse(total: number, found: number) {
  return Math.log(1 + total / Math.max(1, found));
}

function snippetOf(content: string, terms: string[]) {
  for (const line of content.split("\n")) {
    const words = wordsOf(line);
    if (
      line.trim() &&
      !line.startsWith("**Fonti") &&
      !line.startsWith("**Sources") &&
      words.some((word) => terms.some((term) => matchWeight(word, term) === 1))
    ) {
      const text = line
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[#*\-\s>|]+/, "");
      return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
    }
  }
  return "";
}

export function rankPages(
  index: SearchIndex,
  query: string,
  { synonyms, limit = 20 }: { synonyms?: string[][]; limit?: number } = {},
): RankedPage[] {
  const pages = index.pages;
  const total = pages.length;
  const found = new Map<string, number>();
  const pagesWith = (term: string) => {
    let count = found.get(term);
    if (count === undefined) {
      count = pages.filter(
        (page) => countHits(page.words, term) > 0 || setHits(page.titleWords, term) > 0,
      ).length;
      found.set(term, count);
    }
    return count;
  };
  // The words of the query that tell its subject best: the rarest in this office.
  const groups = termGroups(query, synonyms)
    .map((group) => ({
      group,
      pages: Math.min(...group.map(({ term }) => pagesWith(term) || total + 1)),
    }))
    .filter((item) => item.pages <= total)
    .sort((x, y) => x.pages - y.pages)
    .slice(0, MAX_QUERY_TERMS)
    .map((item) => item.group);
  if (groups.length === 0) {
    return [];
  }
  const terms = [...new Set(groups.flatMap((group) => group.map(({ term }) => term)))];

  const { words: exact, forms } = exactTerms(query);
  // The exact word is worth what the prefix lost: about nothing for common words ("corrente" is as
  // rare as "corren"), much for identifiers ("requiresender…" against "requir").
  const exactGain = new Map<string, number>();
  for (const word of exact) {
    const withWord = pages.filter(
      (page) => page.words.has(word) || page.titleWords.has(word),
    ).length;
    if (withWord === 0) {
      continue;
    }
    const prefix = stem(word);
    const withPrefix = pages.filter(
      (page) =>
        [...page.words.keys()].some((item) => item.startsWith(prefix)) ||
        [...page.titleWords].some((item) => item.startsWith(prefix)),
    ).length;
    exactGain.set(word, Math.max(0, inverse(total, withWord) - inverse(total, withPrefix)));
  }
  const formFound = new Map(
    forms.map((form) => [form, pages.filter((page) => page.text.includes(form)).length]),
  );
  const wholeQuery = fold(query).trim();

  const scored: { page: IndexedPage; score: number; telling: number }[] = [];
  for (const page of pages) {
    let score = 0;
    let matched = 0;
    let rare = 0;
    for (const word of exact) {
      const gain = exactGain.get(word);
      if (gain && (page.words.has(word) || page.titleWords.has(word))) {
        score += EXACT_WEIGHT * gain;
      }
    }
    for (const form of forms) {
      const count = formFound.get(form) ?? 0;
      if (count > 0 && page.text.includes(form)) {
        score += EXACT_WEIGHT * inverse(total, count);
      }
    }
    const norm = index.averageSize
      ? BM25_K * (1 - BM25_B + (BM25_B * page.size) / index.averageSize)
      : BM25_K;
    for (const group of groups) {
      let best = 0;
      for (const { term, weight } of group) {
        const withTerm = found.get(term) ?? 0;
        if (withTerm === 0) {
          continue;
        }
        const frequency = countHits(page.words, term);
        const value =
          weight *
          inverse(total, withTerm) *
          (TITLE_WEIGHT * Math.min(1, setHits(page.titleWords, term)) +
            SECTION_WEIGHT * Math.min(1, setHits(page.sectionWords, term)) +
            frequency / (frequency + norm));
        best = Math.max(best, value);
      }
      if (best > 0) {
        matched += 1;
        score += best;
        if (
          group.some(
            ({ term }) =>
              (found.get(term) ?? total) <= Math.max(TELLING_MIN_PAGES, total * TELLING_SHARE),
          )
        ) {
          rare += 1;
        }
      }
    }
    if (score === 0) {
      continue;
    }
    // Pages covering more of the question come first.
    score *= 0.5 + (0.5 * matched) / groups.length;
    if (wholeQuery.length > 3 && fold(page.page.title).includes(wholeQuery)) {
      score += 3;
    }
    if (page.page.outdated) {
      score *= OUTDATED_FACTOR;
    }
    scored.push({ page, score, telling: rare });
  }
  const best = Math.max(0, ...scored.map(({ score }) => score));
  const snippetTerms = [...terms, ...exact];
  return scored
    .filter(({ score }) => score >= best * MIN_RELATIVE_SCORE)
    .sort((x, y) => y.score - x.score || x.page.page.title.localeCompare(y.page.page.title))
    .slice(0, limit)
    .map(({ page, score, telling }) => ({
      slug: page.page.slug,
      score: score / best,
      telling,
      snippet: snippetOf(page.page.content, snippetTerms),
    }));
}
