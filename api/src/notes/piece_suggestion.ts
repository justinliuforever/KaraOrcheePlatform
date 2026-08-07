// The "Possible match" chip's brain. Deterministic, no LLM, silent when unsure: a
// confident wrong match is the one thing this product must never show, so recall is
// deliberately low and every rule below only ever REMOVES candidates.

export interface CandidatePiece {
  id: string;
  title: string;
  subtitle: string;
  composer: string;
}

export interface Suggestion {
  source: "transcript" | "library";
  pieceId: string;
  title: string;
  composer?: string;
  quote?: string;
}

// Matching folds diacritics; identity does not (FG-20). Für may SUGGEST Fur; only the
// teacher may join them.
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Words that carry no identity. "no", "op", numbers and key words stay: they are how
// one étude is told from the next.
const STOPWORDS = new Set([
  "a", "an", "and", "at", "for", "from", "i", "in", "is", "it", "its", "my", "of", "okay",
  "on", "one", "our", "so", "that", "the", "their", "these", "this", "those", "to", "was",
  "we", "with", "you", "your", "just", "now", "piece", "thing",
]);

export function tokens(text: string): string[] {
  const folded = fold(text);
  return folded ? folded.split(" ").filter((t) => t && !STOPWORDS.has(t)) : [];
}

function isSuperset(outer: Set<string>, inner: string[]): boolean {
  return inner.length > 0 && inner.every((t) => outer.has(t));
}

// The teacher SAID this piece: either their words contain the whole title, or the
// title contains all of their words and they said at least two of them. One word is
// never enough — that is how "Beethoven" would become a match.
export function mentionMatches(mention: string, piece: CandidatePiece): boolean {
  const said = tokens(mention);
  if (!said.length) return false;
  const saidSet = new Set(said);
  const titleTokens = tokens(piece.title);
  const pieceTokens = new Set([...titleTokens, ...tokens(piece.subtitle), ...tokens(piece.composer)]);
  const containsTitle = isSuperset(saidSet, titleTokens);
  const titleContainsSaid = said.length >= 2 && isSuperset(pieceTokens, said);
  if (!containsTitle && !titleContainsSaid) return false;
  // Stated as a rule rather than hoped from the token arms: uniqueness that is an
  // accident of catalog size is not evidence the teacher named the piece. A mention
  // whose only overlap is the composer's name is ALWAYS silent.
  const composerTokens = new Set(tokens(piece.composer));
  const overlap = said.filter((t) => pieceTokens.has(t));
  return overlap.some((t) => !composerTokens.has(t));
}

export function displayTitle(piece: CandidatePiece): string {
  return piece.subtitle ? `${piece.title} · ${piece.subtitle}` : piece.title;
}

// Exact normalized equality of a typed label with a catalog title or movement label —
// the answer to "the catalog later gained the piece". Nothing fuzzy: this arm claims
// the library HAS this name, and a near-miss would make that claim false.
export function libraryMatches(label: string, piece: CandidatePiece): boolean {
  const target = fold(label);
  if (!target) return false;
  return target === fold(piece.title) || (!!piece.subtitle && target === fold(piece.subtitle));
}

export interface ComputeInput {
  /// Absent for a lesson that never typed a name.
  customLabel?: string | null;
  mentions: string[];
  transcript?: string | null;
  candidates: CandidatePiece[];
  dismissedPieceIds: string[];
}

// Exactly ONE survivor, or nothing. Two candidates is not "pick the best" — it is
// "we do not know", and the chip stays off the screen.
export function computeSuggestion(input: ComputeInput): Suggestion | null {
  const dismissed = new Set(input.dismissedPieceIds);
  const pool = input.candidates.filter((p) => !dismissed.has(p.id));

  if (input.customLabel) {
    const hits = pool.filter((p) => libraryMatches(input.customLabel!, p));
    if (hits.length === 1) {
      return {
        source: "library",
        pieceId: hits[0]!.id,
        title: displayTitle(hits[0]!),
        composer: hits[0]!.composer || undefined,
      };
    }
    if (hits.length > 1) return null;
  }

  for (const mention of input.mentions) {
    const hits = pool.filter((p) => mentionMatches(mention, p));
    if (hits.length !== 1) continue;
    return {
      source: "transcript",
      pieceId: hits[0]!.id,
      title: displayTitle(hits[0]!),
      composer: hits[0]!.composer || undefined,
      quote: mention,
    };
  }
  return null;
}

export function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}
