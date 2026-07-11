// The ONE registry for every state-tag value in the console. Visual language is
// per-family so color is never the sole carrier:
//   lifecycle — filled pill + leading status dot (dot pulses only while running)
//   rights    — outline pill, no dot; "blocked" is the one filled-red tag that screams
//   shelf     — subtle filled tint, no dot
// Descriptions are the onboarding layer: every tag tooltips one operator-facing sentence.

export type TagFamily = "lifecycle" | "rights" | "shelf";

interface TagDef {
  label: string;
  /** Leading status dot color class — lifecycle only. */
  dot?: string;
  dotPulse?: boolean;
  /** bg/border/text classes for the pill. */
  pill: string;
  description: string;
}

export interface TagSpec extends TagDef {
  family: TagFamily;
}

export const TAGS: Record<TagFamily, Record<string, TagDef>> = {
  lifecycle: {
    draft: {
      label: "draft",
      dot: "bg-gray-400",
      pill: "border-transparent bg-gray-100 text-ink-soft",
      description:
        "Still being assembled in the wizard — nothing has been verified yet, and files and details can change freely.",
    },
    queued: {
      label: "queued",
      dot: "bg-gray-400",
      pill: "border-transparent bg-gray-100 text-ink-soft",
      description: "Submitted and waiting in line — the verification pipeline picks it up automatically.",
    },
    running: {
      label: "running",
      dot: "bg-amber-500",
      dotPulse: true,
      pill: "border-transparent bg-amber-100 text-amber-800",
      description:
        "Automated verification is running right now — engraving, timeline, audio, and on-screen cursor checks.",
    },
    ready_for_review: {
      label: "ready for review",
      dot: "bg-brand",
      pill: "border-transparent bg-brand-soft text-brand",
      description: "All automated checks passed — waiting for a human to review and publish.",
    },
    published: {
      label: "published",
      dot: "bg-ok",
      pill: "border-transparent bg-emerald-100 text-ok",
      description: "Live in the app catalog — this is exactly what students see and download.",
    },
    failed: {
      label: "failed",
      dot: "bg-bad",
      pill: "border-transparent bg-red-100 text-bad",
      description:
        "An automated check found a real problem — open the build to see which gate failed and how to fix the files.",
    },
    canceled: {
      label: "canceled",
      dot: "bg-gray-300",
      pill: "border-transparent bg-gray-100 text-ink-faint",
      description: "Discarded before publishing — kept for reference and can be reopened as a draft.",
    },
    archived: {
      label: "archived",
      dot: "bg-gray-300",
      pill: "border-transparent bg-gray-100 text-ink-faint",
      description:
        "Removed from the app catalog but kept in the registry with all its versions — Restore brings it back.",
    },
  },
  rights: {
    public_domain: {
      label: "public domain",
      pill: "border-emerald-300 bg-transparent text-ok",
      description: "Free of copyright — safe to publish and distribute in the app without a license.",
    },
    licensed: {
      label: "licensed",
      pill: "border-brand/40 bg-transparent text-brand",
      description: "Under copyright, but covered by a license we hold — keep the provenance note current.",
    },
    unknown: {
      label: "unknown",
      pill: "border-amber-300 bg-transparent text-warn",
      description:
        "Copyright status hasn't been established — the piece can't be published until it's resolved.",
    },
    blocked: {
      label: "blocked",
      pill: "border-bad bg-bad text-white",
      description:
        "A rights problem blocks this piece from the catalog — check the rights note before doing anything else.",
    },
  },
  shelf: {
    validated: {
      label: "Pieces",
      pill: "border-transparent bg-emerald-50 text-ok",
      description:
        "Score following is device-validated for this piece — it sits on the main Pieces shelf in the app.",
    },
    experimental: {
      label: "Challenge",
      pill: "border-transparent bg-gray-100 text-ink-soft",
      description:
        "Score following not yet device-validated for this piece — students can practice, but follow accuracy isn't guaranteed.",
    },
  },
};

const FAMILY_ORDER: TagFamily[] = ["lifecycle", "rights", "shelf"];

export function resolveTag(value: string, family?: TagFamily): TagSpec | null {
  if (family) {
    const def = TAGS[family][value];
    return def ? { ...def, family } : null;
  }
  for (const fam of FAMILY_ORDER) {
    const def = TAGS[fam][value];
    if (def) return { ...def, family: fam };
  }
  return null;
}
