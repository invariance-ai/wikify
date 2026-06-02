// Selects the reviewer implementation. Defaults to the baseline heuristics.
// To benchmark the real wiki-review skill (or an API-backed reviewer), add a
// module exporting { name, review } and select it with WIKIFY_REVIEWER=<name>.
import * as baseline from "./baseline.js";

const REVIEWERS = { [baseline.name]: baseline, baseline };

export function getReviewer(which = process.env.WIKIFY_REVIEWER || "baseline") {
  const r = REVIEWERS[which];
  if (!r) throw new Error(`unknown reviewer: ${which} (have: ${Object.keys(REVIEWERS).join(", ")})`);
  return r;
}
