// Baseline reviewer: a small set of regex heuristics. Its only job is to make
// the review-quality benchmark runnable end-to-end and to set a floor that a
// real reviewer must beat. The real target is the `wiki-review` skill (an
// agent/LLM); plug it in by implementing the same interface and selecting it
// via WIKIFY_REVIEWER (see reviewers/index.js).
//
// A reviewer takes { file, code } and returns an array of findings:
//   { line, category, message }
// categories: "correctness" | "security" | "tests" | "clarity"

const RULES = [
  { category: "security", re: /\beval\s*\(/, message: "use of eval()" },
  { category: "security", re: /\bchild_process\b.*\bexec\s*\(/, message: "shell exec with interpolation risk" },
  { category: "correctness", re: /==\s*null|!=\s*null/, message: "loose null comparison (== / !=)" },
  { category: "correctness", re: /\.then\([^)]*\)\s*;?\s*$/, message: "possible unawaited promise" },
  { category: "clarity", re: /\bvar\s+/, message: "use of var instead of let/const" },
  { category: "clarity", re: /\bTODO\b|\bFIXME\b/, message: "unresolved TODO/FIXME" },
];

export function review({ file, code }) {
  const findings = [];
  code.split("\n").forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) findings.push({ file, line: i + 1, category: rule.category, message: rule.message });
    }
  });
  return findings;
}

export const name = "baseline-heuristics";
