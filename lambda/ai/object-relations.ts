import type { StepSuggestionsRequest } from '@app/api/contracts';
import { contradictsFocus } from './focus-constraints';

type Relation = { object: string; place: string; preposition: string; role: 'source' | 'destination' };
type Action = { verb: string; object: string; target?: string; current: boolean };
type ObjectContext = { relations: Relation[]; absent: string[]; action?: Action; chosenPlace?: string; limited: boolean };

const PREPOSITIONS = 'dentro de|dentro del|junto a|al lado de|debajo de|encima de|next to|inside|under|beside|into|onto|sobre|en|a|al|in|on|to|at';
const LOCATION = new RegExp(`^(.+?) (?:está|están|is|are) (${PREPOSITIONS}) (.+)$`, 'iu');
const DESTINATION = new RegExp(`^(.+?) (?:va|van|goes|go|belongs?) (${PREPOSITIONS}) (.+)$`, 'iu');
const ACTION = /^(?:(ahora|now)\s+)?(?:(?:quiero|necesito|i want to|i need to)\s+)?(put away|set aside|put|place|move|transfer|store|remove|take|write|draft|fold|copy|record|log|note|list|guardar|poner|colocar|mover|trasladar|retirar|sacar|llevar|escribir|redactar|doblar|copiar|anotar|registrar|apuntar)\s+(.+)$/iu;
const TRANSFER = /^(?:guardar|poner|colocar|mover|trasladar|llevar|put away|put|place|move|transfer|store)$/iu;
const REMOVE = /^(?:retirar|sacar|remove|take)$/iu;
const WRITE = /^(?:escribir|redactar|write|draft)$/iu;
const RECORD = /^(?:anotar|registrar|apuntar|record|log|note|list)$/iu;
const COPY = /^(?:copiar|copy)$/iu;
const FILE_OBJECT = /\b(?:archivo|documento|file|document)\b|\.[a-z][a-z0-9]{0,9}(?:\b|$)/iu;
const OBJECT_TARGET = new RegExp(`^(.+?) (${PREPOSITIONS}) (.+)$`, 'iu');
const SOURCE = /^(?:de(?:l)?|desde|from|off|out of) (.+)$/iu;
const LEADING_ARTICLE = /^(?:el|la|los|las|un|una|unos|unas|mi|mis|the|a|an|my)\s+/iu;
const SMALL_WRITING = /\b(?:frase|oración|saludo|línea|párrafo|sentence|greeting|line|paragraph)\b/iu;
const COMPOUND = /\s+(?:y|y después|y luego|and|and then|then)\s+(?:\p{L}+(?:ar|er|ir)|put|write|read|move|clean|edit|check|draw|fold)\b/iu;
const LARGE_UNIT = /\b(?:todo|toda|todos|todas|completo|completa|completos|completas|all|entire|whole|complete)\b/iu;
const ARRANGE = /^(?:ordenar|recoger|acomodar|despejar|organizar|guardar|poner|colocar|mover|tidy|organize|organise|clear|declutter|put|place|store|move)\b/iu;
const PRESERVE = /^(?:conservar|mantener|keep|leave)\s+(.+)$/iu;
// A bare "use X" is normally a tool/medium. Only explicit destination wording or
// an ordinary storage place/surface can resolve it as the target of a move.
const STORAGE_PLACE = /^(?:(?:el|la|un|una|the|a|an|my|mi)\s+)?(?:caja|cajón|repisa|estante|estantería|armario|cesto|bolsa|mesa|escritorio|estuche|mochila|maleta|box|drawer|shelf|closet|cabinet|basket|bag|table|desk|case|backpack|suitcase)\b/iu;

function chosenDestination(resource: string): string | undefined {
  const explicit = /^(.+?)\s+(?:como destino|as (?:the )?destination)$/iu.exec(resource);
  if (explicit) return explicit[1]!;
  return STORAGE_PLACE.test(resource) ? resource : undefined;
}

export function relationStatements(text: string): string[] {
  return text.split(/(?:[!?;]|\.(?![\p{L}\p{N}]))\s*/u).map((part) => part.trim()).filter(Boolean);
}

function key(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim().replace(LEADING_ARTICLE, '').replace(/[.!?]+$/u, '').replace(/\s+/gu, ' ');
}

function sameEntity(left: string, right: string): boolean {
  const first = key(left).split(' ');
  const second = key(right).split(' ');
  return first.length === second.length && first.every((word, index) => {
    const other = second[index]!;
    return word === other || word === `${other}s` || other === `${word}s` || word === `${other}es` || other === `${word}es`;
  });
}

function placeKey(place: string): string {
  return key(place.replace(/^(?:junto a|al lado de|encima de|debajo de|next to|inside|under|beside|de|del)\s+/iu, ''));
}

function matchingPlace(left: string, right: string): boolean {
  return placeKey(left) === placeKey(right);
}

function spatialRole(preposition: string): string {
  if (/^(?:en|a|al|in|into|to|at)$/iu.test(preposition)) return 'at';
  if (/^(?:sobre|encima de|on|onto)$/iu.test(preposition)) return 'on';
  if (/^(?:dentro de|dentro del|inside)$/iu.test(preposition)) return 'inside';
  if (/^(?:debajo de|under)$/iu.test(preposition)) return 'under';
  return 'beside';
}

function lowerArticle(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function splitAction(verb: string, remainder: string, current: boolean): Action {
  const removal = /^(move|take|remove)$/iu.test(verb) ? /^(.+?)\s+(off|out of|from)\s+(.+)$/iu.exec(remainder) : null;
  if (removal && (verb.toLowerCase() !== 'move' || removal[2]!.toLowerCase() !== 'from')) {
    return { verb: 'Remove', object: removal[1]!, target: `from ${removal[3]}`, current: true };
  }
  const target = OBJECT_TARGET.exec(remainder);
  return target ? { verb, object: target[1]!, target: `${target[2]} ${target[3]}`, current } : { verb, object: remainder, current };
}

function parsedAction(text: string): Action | undefined {
  const match = ACTION.exec(text);
  return match ? splitAction(match[2]!, match[3]!, Boolean(match[1])) : undefined;
}

/** Shared verbs/targets in a stated sequence are resolved before choosing the next represented unit. */
function nextSequenceAction(clause: string, request: StepSuggestionsRequest): Action | undefined | null {
  const parts = clause.split(/\s+(?:(?:y\s+)?(?:después|luego)|(?:and\s+)?then)\s+/iu);
  if (parts.length < 2) return null;
  const first = parsedAction(parts[0]!);
  if (!first) return undefined;
  const actions = [first, ...parts.slice(1).map((part) => parsedAction(part) ?? splitAction(first.verb, part, false))];
  const sharedTarget = actions.at(-1)?.target;
  if (sharedTarget) for (const action of actions) action.target ??= sharedTarget;
  const represented = request.existingStepTitles.flatMap(relationStatements).map(parsedAction).filter((action): action is Action => Boolean(action));
  const next = actions.find((action) => !represented.some((existing) =>
    ordinaryActionKey(existing.verb) === ordinaryActionKey(action.verb) && sameEntity(existing.object, action.object) &&
    (!existing.target || !action.target || key(existing.target) === key(action.target))));
  return next ? { ...next, current: true } : undefined;
}

function originalFileMustRemain(object: string, request: StepSuggestionsRequest): boolean {
  if (!FILE_OBJECT.test(object)) return false;
  return [...request.ancestorTitles, request.branchTitle, request.focus ?? ''].flatMap(relationStatements).some((clause) => {
    const preservation = PRESERVE.exec(clause)?.[1];
    return preservation !== undefined && /\b(?:original|source)\b/iu.test(preservation);
  });
}

function uniqueObjects(relations: Relation[]): string[] {
  return [...new Map(relations.map((relation) => [key(relation.object), relation.object])).values()];
}

/** Resolve only explicit ordinary-language relations; unknown clauses remain model context. */
function objectContext(request: StepSuggestionsRequest): ObjectContext {
  const result: ObjectContext = { relations: [], absent: [], limited: false };
  const clauses = [...request.ancestorTitles.flatMap(relationStatements), ...relationStatements(request.branchTitle),
    ...relationStatements(request.focus ?? '')];
  const actions: Action[] = [];
  let pronoun: { verb: string; target: string } | undefined;
  for (const clause of clauses) {
    const missing = /^(?:no (?:hay|tengo|tenemos)|there (?:is|are) no|i (?:do not|don't|don’t) have)\s+(.+?)(?:\s+(?:en|sobre|in|on)\s+.+)?$/iu.exec(clause);
    const unavailable = /^(.+?)\s+(?:no (?:está|están) disponible[s]?|is not available|is unavailable|are unavailable)$/iu.exec(clause);
    if (missing || unavailable) {
      result.absent.push((missing ?? unavailable)![1]!);
      continue;
    }
    const location = LOCATION.exec(clause);
    const destination = DESTINATION.exec(clause);
    const relation = destination ?? location;
    if (relation && !/^(?:no|sin|without)\b/iu.test(relation[1]!)) {
      result.relations.push({ object: relation[1]!, preposition: relation[2]!, place: relation[3]!, role: destination ? 'destination' : 'source' });
      continue;
    }
    const use = /^(?:usar|use)\s+(.+)$/iu.exec(clause);
    if (use) {
      const destination = chosenDestination(use[1]!);
      if (destination) result.chosenPlace = destination;
      else result.limited = true;
      continue;
    }
    const referent = /^(gu[aá]rdal[oa]|ponl[oa]|col[oó]cal[oa]|put it|place it|store it)\s+(.+)$/iu.exec(clause);
    if (referent) {
      pronoun = { verb: /^(?:gu|store)/iu.test(referent[1]!) ? (request.language === 'es' ? 'Guardar' : 'Store') :
        request.language === 'es' ? 'Poner' : 'Put', target: referent[2]! };
      continue;
    }
    const sequence = nextSequenceAction(clause, request);
    if (sequence) actions.push(sequence);
    if (sequence === null) {
      const action = parsedAction(clause);
      if (action) actions.push(action);
    }
    if (/\b(?:sin|solo|solamente|without|only|no usar|do not use|don't use)\b/iu.test(clause) || PRESERVE.test(clause)) result.limited = true;
  }
  const current = actions.filter((action) => action.current);
  result.action = current.at(-1) ?? actions.at(-1);
  const objects = uniqueObjects(result.relations);
  if (result.action && /^(?:it|this|that)$/iu.test(result.action.object) && objects.length === 1) {
    result.action.object = objects[0]!;
  }
  if (!result.action && pronoun && objects.length === 1) result.action = { ...pronoun, object: objects[0]!, current: true };
  if (!result.action && result.chosenPlace && objects.length === 1 && ARRANGE.test(request.branchTitle)) {
    result.action = { verb: request.language === 'es' ? 'Poner' : 'Put', object: objects[0]!, current: true };
  }
  return result;
}

function destinationFor(context: ObjectContext, object: string): string | undefined {
  const assigned = context.relations.filter((relation) => relation.role === 'destination' && sameEntity(relation.object, object));
  if (assigned.length === 1) return `${assigned[0]!.preposition} ${assigned[0]!.place}`;
  return undefined;
}

function explicitTarget(context: ObjectContext, language: 'es' | 'en'): string | undefined {
  const action = context.action;
  if (!action) return undefined;
  if (action.target) return action.target;
  const assigned = destinationFor(context, action.object);
  if (assigned) return assigned;
  if (context.chosenPlace) return `${language === 'es' ? 'en' : 'on'} ${context.chosenPlace}`;
  return undefined;
}

export function missingObjectDestination(request: StepSuggestionsRequest): boolean {
  const context = objectContext(request);
  return Boolean(context.action && TRANSFER.test(context.action.verb) &&
    context.relations.length > 0 &&
    !explicitTarget(context, request.language));
}

/** A local action is allowed only for a fully stated relation or a small explicit current unit. */
export function relatedObjectiveFromContext(request: StepSuggestionsRequest): string | null {
  const context = objectContext(request);
  const action = context.action;
  const preserveByCopy = action && TRANSFER.test(action.verb) && originalFileMustRemain(action.object, request);
  if (!action || /^(?:it|this|that)$/iu.test(action.object) || (context.limited && !preserveByCopy) || COMPOUND.test(action.object) || LARGE_UNIT.test(action.object)) return null;
  const verb = preserveByCopy ? (request.language === 'es' ? 'Copiar' : 'Copy') : action.verb;
  let target = action.target;
  if (TRANSFER.test(verb) || COPY.test(verb)) {
    target = explicitTarget(context, request.language);
    if (!target) return null;
  } else if (!(REMOVE.test(verb) && target && SOURCE.test(target)) &&
      (!action.current || !(RECORD.test(verb) || (WRITE.test(verb) && SMALL_WRITING.test(action.object))))) {
    return null;
  }
  const title = `${verb[0]!.toUpperCase()}${verb.slice(1)} ${lowerArticle(action.object)}${target ? ` ${target}` : ''}`;
  if (title.length > 80) return null;
  try {
    validateObjectRelations(verb, action.object, target, request);
    return preserveOrdinaryConstraints(title, request);
  } catch {
    return null;
  }
}

function unavailable(entity: string, context: ObjectContext): boolean {
  return context.absent.some((missing) => sameEntity(missing, entity));
}

/** Validate relation roles in addition to the caller's literal grounding checks. */
export function validateObjectRelations(action: string, object: string, target: string | undefined, request: StepSuggestionsRequest): void {
  const context = objectContext(request);
  if (COMPOUND.test(object) || (target && COMPOUND.test(target)) || LARGE_UNIT.test(object)) throw new Error('more than one small objective');
  if (unavailable(object, context)) throw new Error('objective object is absent');
  const current = context.action;
  const preserveOriginal = originalFileMustRemain(object, request);
  if (preserveOriginal && (TRANSFER.test(action) || REMOVE.test(action) || /^(?:borrar|eliminar|sobrescribir|delete|overwrite)$/iu.test(action))) {
    throw new Error('objective would move or modify the original file');
  }
  const explicitAction = current && (current.current || relationStatements(request.focus ?? '').some((clause) => ACTION.test(clause)));
  const compatibleCopy = preserveOriginal && current && TRANSFER.test(current.verb) && COPY.test(action);
  if (explicitAction && ordinaryActionKey(current.verb) !== ordinaryActionKey(action) && !compatibleCopy) {
    throw new Error('objective changed the current operation');
  }
  if (current && !sameEntity(current.object, object) &&
      (TRANSFER.test(current.verb) || current.current)) {
    throw new Error('objective changed the current object');
  }
  if (!target) {
    if ((TRANSFER.test(action) || COPY.test(action)) && context.relations.some((relation) => sameEntity(relation.object, object))) {
      throw new Error('objective needs the named object destination');
    }
    return;
  }
  const source = SOURCE.exec(target);
  const located = OBJECT_TARGET.exec(`object ${target}`);
  const place = source?.[1] ?? located?.[3];
  if (!place) return;
  if (unavailable(place, context)) throw new Error('objective destination is absent');
  const objectRelations = context.relations.filter((relation) => sameEntity(relation.object, object));
  if (source && REMOVE.test(action)) {
    const sourceLocation = OBJECT_TARGET.exec(`object ${source[1]}`);
    if (objectRelations.length && !objectRelations.some((relation) => relation.role === 'source' && matchingPlace(relation.place, place) &&
      (!sourceLocation || spatialRole(relation.preposition) === spatialRole(sourceLocation[2]!)))) {
      throw new Error('objective source is not the object location');
    }
    return;
  }
  if (!TRANSFER.test(action) && !COPY.test(action)) return;
  const destination = current && sameEntity(current.object, object) ? explicitTarget(context, request.language) : destinationFor(context, object);
  if (destination) {
    const expected = OBJECT_TARGET.exec(`object ${destination}`);
    if (!expected || !located || !matchingPlace(expected[3]!, place) || spatialRole(expected[2]!) !== spatialRole(located[2]!)) {
      throw new Error('objective changed the assigned destination');
    }
  } else if (objectRelations.length || context.relations.some((relation) => matchingPlace(relation.place, place))) {
    throw new Error('objective destination is only a stated location');
  }
}

export function ordinaryActionKey(action: string): string {
  if (TRANSFER.test(action)) return 'transfer';
  if (WRITE.test(action)) return 'write';
  if (RECORD.test(action)) return 'record';
  if (REMOVE.test(action)) return 'remove';
  return action.toLowerCase();
}

/** Keep stated prohibitions/medium constraints with the saved title, even if the model omitted them. */
export function preserveOrdinaryConstraints(title: string, request: StepSuggestionsRequest): string {
  const sources = [...request.ancestorTitles, request.branchTitle, request.focus ?? ''];
  if (sources.some((source) => contradictsFocus(title, source, request.language))) {
    throw new Error('objective contradicts a supplied restriction');
  }
  const restrictions = sources.flatMap(relationStatements).flatMap((clause) => {
    const resource = /^(?:usar|use)\s+(.+)$/iu.exec(clause)?.[1];
    if (resource && !chosenDestination(resource)) {
      return [`${request.language === 'es' ? 'usando' : 'using'} ${resource}`];
    }
    const preservation = PRESERVE.exec(clause);
    if (preservation) {
      const proposed = /^(borrar|eliminar|romper|destruir|sobrescribir|mover|retirar|delete|remove|destroy|overwrite|move)\s+(.+)$/iu.exec(title);
      if (proposed && (key(proposed[2]!).includes(key(preservation[1]!)) || key(preservation[1]!).startsWith(key(proposed[2]!)))) {
        throw new Error('objective changes an object that must be preserved');
      }
      return [lowerArticle(clause)];
    }
    const match = /(?:^|[, ]+)((?:sin|without)\s+.+|(?:solo|solamente|only)\s+(?:con|en|por|with|in|on|using)\s+.+|no\s+\p{L}+(?:ar|er|ir)\s+.+|(?:do not|don't|don’t)\s+.+)$/iu.exec(clause);
    return match ? [lowerArticle(match[1]!)] : [];
  });
  const unique = [...new Map(restrictions.map((restriction) => [key(restriction), restriction])).values()];
  const missing = unique.filter((restriction) => !key(title).includes(key(restriction)));
  const complete = [title, ...missing].join(', ');
  if (complete.length > 80) throw new Error('objective and restrictions do not fit');
  return complete;
}
