import type { StepSuggestionsRequest } from '@app/api/contracts';

const ACTION = /^(?:decir|pronunciar|escribir|redactar|copiar|corregir|anotar|dibujar|trazar|sombrear(?:lo|la)?|leer|tocar|comparar|distinguir|resolver|despejar|explicar|describir|pedir|preguntar|responder|saludar|presentarme|contar|reconocer|respirar|cambiar|say|pronounce|write|draft|copy|correct|note|draw|trace|shade|read|play|compare|distinguish|solve|isolate|explain|describe|order|ask|answer|greet|introduce|tell|recognize|breathe|change)(?:\s|$)/iu;
const SEQUENCE = /\s+(?:y\s+(?:después|luego)|and\s+then)\s+|\s+(?:y|and)\s+(?=(?:escribir|corregir|dibujar|sombrear|leer|tocar|write|correct|draw|shade|read|play)\b)/iu;
const COMPLETED = /^(?:ya\s+(?:lo\s+|la\s+|los\s+|las\s+)?(?:he\s+|sé\s+|se\s+)?|i\s+(?:already|have\s+already)\s+|already\s+)/iu;
const FACT = /^(?:(?:un|una|el|la|a|an|the)\s+.+\s+(?:en|está|están|at|is|are)\s+|(?:estoy|tengo|hay|i am|i have|there is|there are)\s+)/iu;
const GENERIC = /^(?:(?:quiero|necesito|i want to|i need to)\s+)?(?:mejorar|avanzar|practicar|repasar|continuar|seguir practicando|improve|practice|review|keep practicing)(?:\s+(?:un poco|más|lo de siempre|lo de ayer|algo|a little|more|the usual|something))?[.!?]?$/iu;
const INFINITIVE = /^(?!(?:aprender|estudiar|practicar|repasar)\s)\p{L}+(?:ar|er|ir|ír)(?:lo|la|los|las)?\s+\S/iu;

export type PracticeContext = {
  goal?: string;
  direct: boolean;
  constraints: string[];
  completed: string[];
  unresolved: boolean;
  goals: string[];
};

function clean(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').replace(/[.!?]+$/u, '');
}

/** Normalize surface variants of the same activity, retaining its object and limits. */
export function practiceActivityKey(title: string): string {
  return clean(title).toLowerCase()
    .replace(/^(?:pronunciar|repetir|decir)\s+/u, 'decir ')
    .replace(/^(?:pronounce|repeat|say)\s+/u, 'say ')
    .replace(/^(?:redactar|copiar|escribir)\s+/u, 'escribir ')
    .replace(/^(?:draft|copy|write)\s+/u, 'write ')
    .replace(/\s+(?:en voz alta|aloud|out loud)$/u, '')
    .replace(/\s+(?:una vez|once)$/u, '')
    .replace(/\b(?:la suma|the sum)\s+/gu, '')
    .replace(/[«»“”"']/gu, '').trim();
}

export function isVaguePractice(text: string): boolean {
  const value = clean(text).replace(/\s+(?:pero no s[ée] qu[ée] practicar|but i don't know what to practice)$/iu, '');
  return GENERIC.test(value);
}

function actionText(clause: string): { text: string; current: boolean; direct: boolean } {
  const current = /^(?:ahora|now)\b/iu.test(clause);
  const indirect = /^(?:me cuesta|i struggle to|i find it hard to)\s/iu.test(clause);
  const text = clause.replace(/^[^,]+,\s+(?=i (?:want|need) to\s)/iu, '')
    .replace(/^(?:(?:ahora|now|después|luego|then)\s+)?(?:(?:quiero|necesito|i want to|i need to|me cuesta|i struggle to|i find it hard to)\s+)?/iu, '')
    .replace(/^empezar despejando\s/iu, 'despejar ').replace(/^start by isolating\s/iu, 'isolate ');
  return { text, current, direct: !indirect };
}

function asConstraint(clause: string): string | null {
  if (/^usar .+ para escribir /iu.test(clause)) return null;
  if (/^(?:sin|no\s+(?:usar|hablar|tocar|borrar)|without|do not|don't)\b/iu.test(clause)) {
    return clause.replace(/^no\s+/iu, 'sin ').replace(/^(?:do not|don't)\s+/iu, 'without ');
  }
  if (/^(?:solo|solamente|only)\s/iu.test(clause)) return clause;
  const using = /^(?:usar|use)\s+(?:(solo|only)\s+)?(.+)$/iu.exec(clause);
  if (using) {
    const es = /^usar\s/iu.test(clause);
    const object = using[2]!;
    // A requested grammatical form is a manner; a named tool/body side is instrumental.
    const preposition = es ? /^(?:pasado|presente|futuro|pret[ée]rito|condicional|subjuntivo)\b/iu.test(object) ? 'en' : 'con' : 'with';
    return `${preposition} ${object}${using[1] ? es ? ' solamente' : ' only' : ''}`;
  }
  return null;
}

function spokenWords(goal: string): string | null {
  return /^(?:pronunciar|decir|say|pronounce)\s+(.+?)(?:\s+en voz alta|\s+aloud|\s+out loud)?$/iu.exec(goal)?.[1] ?? null;
}

function resolveReference(goal: string, earlier: string[]): string {
  if (/^(?:escribir|copiar) (?:ambas|las dos|esas) palabras$/iu.test(goal)) {
    const words = earlier.map(spokenWords).reverse().find((value) => value !== null);
    if (words) return `escribir ${words}`;
  }
  if (/^(?:write|copy) (?:both|these|those) words$/iu.test(goal)) {
    const words = earlier.map(spokenWords).reverse().find((value) => value !== null);
    if (words) return `write ${words}`;
  }
  if (/^explicar c[oó]mo lo hice$/iu.test(goal)) {
    const problem = earlier.map((part) => /^resolver (.+)$/iu.exec(part)?.[1]).reverse().find(Boolean);
    if (problem) return `explicar cómo resolví ${problem}`;
  }
  return goal;
}

/** Extract only explicit grammar. Unknown clauses prevent a local shortcut. */
export function practiceContext(request: StepSuggestionsRequest): PracticeContext {
  const source = request.focus || request.branchTitle;
  const clauses = source.split(/(?:[!?;]|\.(?![\p{L}\p{N}]))\s*/u).flatMap((part) => part.split(SEQUENCE))
    .map(clean).filter(Boolean);
  const constraints: string[] = [];
  const completed: string[] = [];
  const completedActivities = new Set<string>();
  const goals: Array<{ text: string; current: boolean; direct: boolean }> = [];
  let unresolved = false;
  for (const clause of clauses) {
    const constraint = asConstraint(clause);
    if (constraint) { constraints.push(constraint); continue; }
    if (COMPLETED.test(clause)) {
      completed.push(clause);
      if (/^(?:ya (?:lo|la|los|las)\s|i (?:already|have already) (?:did|finished) (?:it|them))\b/iu.test(clause)) {
        const previous = goals[goals.length - 1];
        if (previous) completedActivities.add(practiceActivityKey(previous.text));
      }
      continue;
    }
    const action = actionText(clause);
    if (ACTION.test(action.text) || (request.language === 'es' && (INFINITIVE.test(action.text) || /^\p{L}+(?:ar|er|ir)(?:lo|la|los|las)$/iu.test(action.text))) || /^(?:practicar la pronunciación de|practicar el saludo|practice the greeting|fold|sew|count|paint)\s/iu.test(action.text) ||
        /^usar .+ para escribir /iu.test(action.text)) {
      goals.push({ ...action, text: resolveReference(action.text, goals.map((goal) => goal.text)) });
    } else if (!FACT.test(clause) && !/^(?:(?:luego|then)\s+)?[\p{L}\p{N}]+\s*=\s*[^=]+$/u.test(clause) && !isVaguePractice(clause)) {
      // Broad practice titles and skill names can be explained by a concrete ancestor.
      unresolved = true;
    }
  }
  if (!goals.length && !request.focus) {
    const concrete = [...request.ancestorTitles].reverse().find((title) => ACTION.test(title));
    if (concrete) {
      goals.push({ text: clean(concrete), current: false, direct: true });
      unresolved = false;
    }
  }
  // Conditions on the path remain applicable to the focused child. Keep their
  // source text instead of assuming a later request silently revokes them.
  for (const source of [request.treeTitle, ...request.ancestorTitles, request.branchTitle]) {
    for (const clause of source.split(/(?:[!?;]|\.(?![\p{L}\p{N}]))\s*/u).map(clean).filter(Boolean)) {
      const condition = asConstraint(clause) ?? /(?:^|\s)((?:sin|without)\s+.+)$/iu.exec(clause)?.[1];
      if (condition && !constraints.some((given) => given.toLowerCase() === condition.toLowerCase())) constraints.push(condition);
    }
  }
  const represented = new Set(request.existingStepTitles.map(practiceActivityKey));
  const current = [...goals].reverse().find((goal) => goal.current);
  const selected = current ?? goals.find((goal) => !represented.has(practiceActivityKey(goal.text)) &&
    !completedActivities.has(practiceActivityKey(goal.text)));
  // A condition can follow the object in the same sentence. Preserve the whole
  // suffix so pace + tool/body side cannot be lost when the model selects a noun.
  // Comparisons use with/con to introduce an operand rather than an instrument.
  if (selected) {
    // "Pronunciar en voz alta X" places this fixed manner before the object;
    // only the manner belongs to the condition, not X or a following purpose.
    const leadingManner = /^\S+\s+(en voz alta)\s+/iu.exec(selected.text)?.[1];
    const constraintText = leadingManner ? selected.text.replace(/^(\S+)\s+en voz alta\s+/iu, '$1 ') : selected.text;
    if (leadingManner && !constraints.some((condition) => condition.toLowerCase() === leadingManner.toLowerCase())) constraints.push(leadingManner);
    const scope = /\s+((?:despacio|lentamente|suavemente|slowly|softly|quietly)(?:\s+.+)?|(?:usando|using|sin|without|en|in)\s+.+)$/iu.exec(constraintText)?.[1];
    const instrument = practiceActionFamily(selected.text) !== 'compare' ? /\s+((?:con|with)\s+.+)$/iu.exec(constraintText)?.[1] : undefined;
    const inline = [scope, instrument].filter((value): value is string => value !== undefined).sort((a, b) => b.length - a.length)[0];
    if (inline && !constraints.some((condition) => condition.toLowerCase() === inline.toLowerCase())) constraints.push(inline);
  }
  return { goal: selected?.text, direct: selected?.direct ?? false, constraints, completed, unresolved,
    goals: goals.map((goal) => goal.text) };
}

export function withPracticeConstraints(title: string, context: PracticeContext): string {
  let result = title;
  for (const condition of context.constraints) {
    if (!result.toLowerCase().includes(condition.toLowerCase())) {
      result += ` ${condition.charAt(0).toLowerCase()}${condition.slice(1)}`;
    }
  }
  return result;
}

export function practiceActionFamily(text: string): string | undefined {
  const value = text.replace(/^(?:me cuesta|i struggle to)\s+/iu, '');
  if (/^usar .+ para escribir /iu.test(value)) return 'write';
  if (/^(?:reconocer .+ al escuchar|anotar si oyes|listen to .+ and note)/iu.test(value)) return 'listen';
  if (/^(?:pedir|preguntar|responder|saludar|presentarme|contar|order|ask|answer|greet|introduce|tell)\b/iu.test(value)) return 'say';
  if (/^(?:decir|pronunciar|say|pronounce)\b/iu.test(value)) return 'say';
  if (/^(?:escribir|redactar|copiar|anotar|write|draft|copy|note)\b/iu.test(value)) return 'write';
  if (/^(?:dibujar|trazar|draw|trace)\b/iu.test(value)) return 'draw';
  if (/^(?:tocar|play)\b/iu.test(value)) return 'play';
  if (/^(?:resolver|despejar|solve|isolate)\b/iu.test(value)) return 'solve';
  if (/^(?:explicar|describir|explain|describe)\b/iu.test(value)) return 'explain';
  if (/^(?:comparar|distinguir|compare|distinguish)\b/iu.test(value)) return 'compare';
  if (/^(?:identificar|encontrar|identify|find)\b/iu.test(value)) return 'find';
  if (/^(?:leer|read)\b/iu.test(value)) return 'read';
  if (INFINITIVE.test(value)) return `action:${value.split(/\s/u)[0]!.toLowerCase()}`;
  return undefined;
}
