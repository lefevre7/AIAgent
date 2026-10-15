/**
 * Words and ranking for searching short texts: `tool_search` over tool
 * definitions, `mcp_search` over MCP capabilities, and the lexical half of
 * memory search. One tokenizer and one ranker, so the three cannot drift
 * apart; each use picks the options it needs.
 */

// Words so common they match nearly everything: dropped from queries and from
// what is indexed alike. The two-letter ones are here, rather than a minimum
// length of three, so a two-character name (`gh`, `s3`, `ui`) stays findable.
const STOP_WORDS = new Set([
  "about",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "should",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your"
]);

export type SearchTokenizeOptions = {
  /** Split `readFile` and `HTTPServer` into words before lowercasing. Default true. */
  camelCase?: boolean;
  /** Shortest word kept. Default 2: `gh` and `s3` are words, a single letter is not. */
  minLength?: number;
  /** Reduce plurals: `files` → file, `patches` → patch, `queries` → query. Default true. */
  stem?: boolean;
};

/**
 * The words of `text` for searching: runs of Unicode letters and digits (so
 * "búsqueda" and "検索" are words, not fragments), lowercased, with
 * `snake_case` and `kebab-case` split, stop words dropped, and by default
 * `camelCase` split and plurals reduced, so "read-file", "readFile" and
 * "read files" all meet `read_file`.
 */
export function tokenizeForSearch(text: string, options: SearchTokenizeOptions = {}): string[] {
  const split =
    options.camelCase === false
      ? text
      : text.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  const minLength = options.minLength ?? 2;
  const words = splitSearchWords(split.toLowerCase()).filter(
    (word) => word.length >= minLength && !STOP_WORDS.has(word)
  );
  return options.stem === false ? words : words.map(stemPlural);
}

/** Every run of Unicode letters and digits in `text`, as written: no case change, nothing dropped. */
export function splitSearchWords(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

function stemPlural(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 4 && /(?:ch|sh|ss|x|z)es$/u.test(word)) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/u.test(word)) {
    return word.slice(0, -1);
  }
  return word;
}

// BM25's usual constants: term-frequency saturation and length normalization.
const K1 = 1.2;
const B = 0.75;
// A query word that only begins a document word ("browse" in "browser")
// counts, for a fraction of a whole-word match.
const PREFIX_MATCH_WEIGHT = 0.6;
const MIN_PREFIX_LENGTH = 4;

/** One document's words, per field, counted once and reused for every query. */
export type IndexedSearchDocument<F extends string> = {
  fields: Map<F, Map<string, number>>;
  /** Its words, each weighted by its field's weight: BM25's document length. */
  length: number;
};

/**
 * Field-weighted BM25 over documents with named text fields. Indexing (the
 * tokenizing) is the costly part, so a caller indexes each document once and
 * keeps the result; ranking only reads it.
 */
export class FieldSearchRanker<F extends string> {
  constructor(private readonly weights: Readonly<Record<F, number>>) {}

  index(texts: Partial<Record<F, readonly string[]>>): IndexedSearchDocument<F> {
    const fields = new Map<F, Map<string, number>>();
    let length = 0;
    for (const [field, values] of Object.entries(texts) as Array<[F, readonly string[] | undefined]>) {
      const counts = new Map<string, number>();
      for (const word of (values ?? []).flatMap((value) => tokenizeForSearch(value))) {
        counts.set(word, (counts.get(word) ?? 0) + 1);
        length += this.weights[field];
      }
      if (counts.size > 0) {
        fields.set(field, counts);
      }
    }
    return { fields, length };
  }

  /**
   * Each document's score for `queryWords` (0 when none of them is in it),
   * and the fields they were found in. A word counts less the more of the
   * documents it is in, and a long document counts each word for less.
   */
  rank(
    documents: ReadonlyArray<IndexedSearchDocument<F>>,
    queryWords: readonly string[]
  ): Array<{ matchedOn: F[]; score: number }> {
    const words = [...new Set(queryWords)];
    const averageLength = documents.reduce((total, document) => total + document.length, 0) / (documents.length || 1);
    // Each (document, word) pair is counted once, then read twice: for the
    // word's document frequency and for the document's score.
    const frequencies = documents.map((document) => words.map((word) => this.termFrequency(document, word)));
    const documentFrequency = words.map(
      (_, wordIndex) => frequencies.filter((perWord) => perWord[wordIndex]!.total > 0).length
    );
    return documents.map((document, documentIndex) => {
      let score = 0;
      const matchedOn = new Set<F>();
      words.forEach((_, wordIndex) => {
        const { byField, total } = frequencies[documentIndex]![wordIndex]!;
        if (total === 0) {
          return;
        }
        const df = documentFrequency[wordIndex]!;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        score += (idf * (total * (K1 + 1))) / (total + K1 * (1 - B + (B * document.length) / (averageLength || 1)));
        byField.forEach((field) => matchedOn.add(field));
      });
      return { matchedOn: [...matchedOn], score };
    });
  }

  // The weighted frequency of a query word in one document: whole words plus
  // partial credit for words it begins, and the fields it was found in.
  private termFrequency(document: IndexedSearchDocument<F>, word: string): { byField: F[]; total: number } {
    let total = 0;
    const byField: F[] = [];
    for (const [field, counts] of document.fields) {
      let inField = counts.get(word) ?? 0;
      if (word.length >= MIN_PREFIX_LENGTH) {
        for (const [token, count] of counts) {
          if (token !== word && token.startsWith(word)) {
            inField += PREFIX_MATCH_WEIGHT * count;
          }
        }
      }
      if (inField > 0) {
        total += this.weights[field] * inField;
        byField.push(field);
      }
    }
    return { byField, total };
  }
}
