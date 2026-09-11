const ABSENCE_PATTERNS = [
  /\bno\s+(?:(?:visible|loading)\s+)?(?:response|feedback|indicator)\b/i,
  /\bnothing happened\b/i,
  /\b(?:does|did) nothing\b/i,
  /\bscreen (?:did not|didn't) change\b/i,
  /\b(?:button|control|app|interface|screen|page|ui) (?:did not|didn't|does not|doesn't|never) respond\b/i,
  /\bwithout (?:any )?(?:visual )?(?:response|feedback|indicator)\b/i,
  /\b(?:screen|page|view|ui) (?:remained|stayed|was) unchanged\b/i,
  /\bno (?:visible|visual) change\b/i,
  /\bno (?:error |success |confirmation |status )?(?:message|banner|toast) (?:appeared|was shown)\b/i,
] as const;

export function claimsAbsence(text: string): boolean {
  return ABSENCE_PATTERNS.some((pattern) => pattern.test(text));
}
