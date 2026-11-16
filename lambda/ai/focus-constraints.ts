const CLAUSE_BREAK = /[.,;:!?]|\s+(?:pero|y luego|but|and then)\s+/iu;
const NEGATION = { es: /\b(?:sin|no)\s+/iu, en: /\b(?:without|do not|don['’]t)\s+/iu };
const JOIN = { es: /\s+y\s+/iu, en: /\s+and\s+/iu };
const ALTERNATIVES = {
  es: /\s+ni\s+(?=\p{L}+(?:ar|er|ir)(?:me|te|se|nos|os)?(?:\s|$))/iu,
  en: /\s+or\s+(?=[a-z]+ing(?:\s|$))/iu,
};
const FUNCTION_WORDS = {
  es: new Set('a al de del el la las lo los un una unos unas me te se nos os mi mis tu tus su sus nada ningun ninguna ningunas ningunos'.split(' ')),
  en: new Set('a an any anything the of to my your their'.split(' ')),
};

function words(text: string, language: 'es' | 'en'): string[] {
  const normalized = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return (normalized.match(/[a-z]+/gu) ?? [])
    .filter((word) => !FUNCTION_WORDS[language].has(word))
    .map((word) => language === 'es'
      ? word.replace(/(ar|er|ir)(?:me|te|se|nos|os|lo|la|los|las)$/u, '$1')
        .replace(/([^aeiou])es$/u, '$1').replace(/([aeiou])s$/u, '$1')
      : word.replace(/(?:ing|(?<!s)s)$/u, '').replace(/e$/u, ''));
}

function inflectionMatches(word: string, infinitive: string): boolean {
  const stem = /^([a-z]{3,})(?:ar|er|ir)$/u.exec(infinitive)?.[1];
  return stem !== undefined && word.startsWith(stem) &&
    /^(?:(?:a|e|an|en|as|es)(?:me|te|se|nos|os)?)?$/u.test(word.slice(stem.length));
}

/** Match literal prohibitions and common word forms within their stated scope. */
export function contradictsFocus(title: string, focus: string, language: 'es' | 'en'): boolean {
  const negation = NEGATION[language];
  const positiveTitle = title.split(CLAUSE_BREAK)
    .flatMap((clause) => clause.split(JOIN[language])).map((clause) => clause.split(negation)[0]).join(' ');
  const proposed = new Set(words(positiveTitle, language));
  const restrictions = focus.split(CLAUSE_BREAK)
    .flatMap((clause) => clause.split(negation).slice(1))
    .flatMap((clause) => clause.trim().replace(/\s+(?:y|and)$/iu, '').split(ALTERNATIVES[language]));
  return restrictions.some((restriction) => {
    const [action, ...scope] = words(restriction, language);
    if (action === undefined || !scope.every((word) => proposed.has(word))) return false;
    return proposed.has(action) || (language === 'es' && [...proposed].some((word) =>
      inflectionMatches(word, action) || inflectionMatches(action, word)));
  });
}
