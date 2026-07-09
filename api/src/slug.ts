const STOP = new Set(["the", "a", "an", "in", "of", "for", "und", "et", "de", "la", "le"]);

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Digit-bearing tokens are identity (opus/catalogue/movement numbers — "Hob. XVI:48"
// must never truncate to "XVI"): the cap applies to prose tokens only.
function tokens(s: string, max: number): string {
  const all = slugify(s)
    .split("_")
    .filter((w) => w && !STOP.has(w));
  const out: string[] = [];
  let prose = 0;
  for (const w of all) {
    if (/\d/.test(w)) {
      out.push(w);
    } else if (prose < max) {
      out.push(w);
      prose += 1;
    }
  }
  return out.join("_");
}

// Catalogue numbers compare loosely: "K. 330" == "K330" == "k.330".
export function normalizeCatalogue(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Deterministic piece identity: composer surname + title + subtitle keys. The slug is
// the permanent asset id — same metadata always maps to the same slug, so re-uploading
// a piece intentionally lands on the same id (version bump), never a near-duplicate.
export function pieceSlug(composer: string, title: string, subtitle: string): string {
  const surname = slugify(composer).split("_").pop() ?? "";
  // Generous token budgets: catalogue numbers ("Op. 36 No. 1") are identity-bearing
  // and must never truncate away.
  return [surname, tokens(title, 6), tokens(subtitle, 4)]
    .filter(Boolean)
    .join("_")
    .slice(0, 64)
    .replace(/_+$/, "");
}

export function bookSlug(title: string): string {
  return tokens(title, 5).slice(0, 64).replace(/_+$/, "");
}
