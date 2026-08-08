// Every matching rule here must only REMOVE candidates — never loosen a match; a confident wrong match must never show.

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

// fold() is for matching only — identity (customPieces) uses raw NFC, so Für may SUGGEST Fur but only the teacher may join them.
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Do not add "no"/"op"/numbers/key words to STOPWORDS — they distinguish one étude from another.
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

// said.length must stay >= 2 for the title-contains-said arm — at 1, a bare "Beethoven" mention would match.
export function mentionMatches(mention: string, piece: CandidatePiece): boolean {
  const said = tokens(mention);
  if (!said.length) return false;
  const saidSet = new Set(said);
  const titleTokens = tokens(piece.title);
  const pieceTokens = new Set([...titleTokens, ...tokens(piece.subtitle), ...tokens(piece.composer)]);
  const containsTitle = isSuperset(saidSet, titleTokens);
  const titleContainsSaid = said.length >= 2 && isSuperset(pieceTokens, said);
  if (!containsTitle && !titleContainsSaid) return false;
  // Even when the arms above pass, overlap must include a non-composer token — composer-only overlap is never a match.
  const composerTokens = new Set(tokens(piece.composer));
  const overlap = said.filter((t) => pieceTokens.has(t));
  return overlap.some((t) => !composerTokens.has(t));
}

export function displayTitle(piece: CandidatePiece): string {
  return piece.subtitle ? `${piece.title} · ${piece.subtitle}` : piece.title;
}

// Must stay exact equality, never fuzzy — this arm claims the library HAS this name, and a near-miss would make that false.
export function libraryMatches(label: string, piece: CandidatePiece): boolean {
  const target = fold(label);
  if (!target) return false;
  return target === fold(piece.title) || (!!piece.subtitle && target === fold(piece.subtitle));
}

export interface ComputeInput {
  customLabel?: string | null;
  mentions: string[];
  transcript?: string | null;
  candidates: CandidatePiece[];
  dismissedPieceIds: string[];
}

// hits.length > 1 must return null, never pick "best" — ambiguity means "we do not know", not "guess".
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
