export function responseOutcome(subject: string, snippet = '') {
  if (/\b(?:unfortunately|not (?:moving|progressing) forward|unsuccessful|regret to inform|absage|leider nicht)\b/i.test(subject)) return 'rejected';
  if (/\b(?:we(?:'ve| have) received your application|we received your application|application (?:received|confirmation)|thank you for (?:applying|your application)|eingangsbestätigung|bewerbung erhalten|(?:danke|vielen dank) für (?:deine|ihre) bewerbung)\b/i.test(subject)) return 'unrelated';
  if (/^(?:your job offer|offer of employment|ihr arbeitsangebot)\b/i.test(subject)) return 'offer';
  if (/\b(?:interview invit(?:ation|e)|invit(?:ation|e) to (?:an? |your )?interview|einladung.{0,60}(?:vorstellungsgespräch|kennenlerngespräch|interview))\b/i.test(subject)) return 'positive';
  if (/\b(?:unfortunately.{0,100}(?:not (?:be moving|move|proceed)|other candidates)|leider.{0,100}(?:nicht berücksichtigen|absagen))\b/i.test(snippet)) return 'rejected';
  if (/\b(?:we(?:'d| would) like to invite you (?:to|for) (?:an? |your )?(?:.{0,35} )?interview|wir möchten (?:sie|dich).{0,80}(?:vorstellungsgespräch|kennenlerngespräch).{0,35}einladen)\b/i.test(snippet)) return 'positive';
  return 'review';
}

export function senderAddress(sender: string) {
  return (sender.match(/<([^<>]+)>\s*$/)?.[1] ?? sender).trim().toLowerCase();
}

export function companyFromSender(sender: string) {
  const name = sender.match(/^(.+?)\s*<[^>]+>$/)?.[1].replace(/^"|"$/g, '').trim() ?? '';
  return name.replace(/\s+(?:via Workable|Careers|Recruiting|Talent Acquisition)$/i, '').slice(0, 200);
}
