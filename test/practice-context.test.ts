import { describe, expect, it } from 'vitest';
import type { StepSuggestionsRequest } from '@app/api/contracts';
import { needsPracticeDetail, practiceExerciseFromContext, renderPracticeExercise } from '../lambda/ai/practice-exercises';

function request(focus: string, changes: Partial<StepSuggestionsRequest> = {}): StepSuggestionsRequest {
  return { language: 'es', treeTitle: 'Estudiar inglés', branchTitle: 'Estudiar inglés', ancestorTitles: [],
    existingStepTitles: [], maxSuggestions: 1, focus, ...changes };
}

describe('practice context fidelity', () => {
  it('retains a required body side from the second sentence', () => {
    const result = practiceExerciseFromContext(request('Play the notes C, D and E. Use only my left hand.', {
      language: 'en', treeTitle: 'Learn piano', branchTitle: 'Learn piano',
    }));
    expect(result).toMatch(/^Play .*C.*D.*E.*left hand/);
  });

  it('reduces a page plus corrections to one sentence about the supplied subject', () => {
    const result = practiceExerciseFromContext(request('Escribir una página sobre mi familia y corregir todos los errores'));
    expect(result).toMatch(/^Escribir una (frase|oración) sobre mi familia$/u);
  });

  it('chooses the first action of an explicitly ordered sequence', () => {
    expect(practiceExerciseFromContext(request('Dibujar un círculo y después sombrearlo'))).toBe('Dibujar un círculo');
  });

  it.each(['Decir cat y dog en voz alta.', 'Pronunciar cat y dog en voz alta'])('continues after the represented activity %s', (prior) => {
    const result = practiceExerciseFromContext(request('Pronunciar cat y dog. Después escribir ambas palabras.', {
      existingStepTitles: [prior],
    }));
    expect(result).toBe('Escribir cat y dog');
  });

  it('uses the current explaining goal after a finished calculation', () => {
    const result = practiceExerciseFromContext(request('Resolver 2 + 3. Ya lo resolví; ahora explicar cómo lo hice.', {
      treeTitle: 'Aprender matemáticas', branchTitle: 'Aprender matemáticas', existingStepTitles: ['Resolver la suma 2 + 3'],
    }));
    expect(result).toMatch(/^Explicar .*2 \+ 3/u);
    expect(result).not.toMatch(/^Resolver/u);
  });

  it('does not let a named position override an explicit explaining goal', () => {
    const result = practiceExerciseFromContext(request('Un caballo en d4. Explicar por qué el salto forma una L.', {
      treeTitle: 'Aprender ajedrez', branchTitle: 'Practicar el movimiento del caballo',
    }));
    expect(result).toMatch(/^Explicar .*salto.*L/u);
  });

  it('carries a second-sentence tense into the smaller writing result', () => {
    expect(practiceExerciseFromContext(request('Escribir un párrafo. Usar pasado simple.')))
      .toBe('Escribir una frase en pasado simple');
  });

  it('keeps a second-sentence restriction while comparing', () => {
    expect(practiceExerciseFromContext(request('Comparar 2/3 y 3/5. Sin usar decimales.')))
      .toBe('Comparar 2/3 y 3/5 sin usar decimales');
  });

  it('does not silently ignore an unrecognized later instruction', () => {
    expect(practiceExerciseFromContext(request('Escribir una frase. Mi profesora pidió otra cosa.'))).toBeNull();
  });

  it('requests a useful focus for a vague paraphrase', () => {
    expect(needsPracticeDetail(request('Quiero mejorar un poco'))).toBe(true);
  });

  it('rejects speaking a grammar label when the stated activity is writing', () => {
    expect(() => renderPracticeExercise(JSON.stringify({ kind: 'say', subject: 'pasado simple' }),
      request('Me cuesta escribir frases en pasado simple'))).toThrow();
  });

  it('rejects reading an object aloud when the stated activity is drawing', () => {
    expect(() => renderPracticeExercise(JSON.stringify({ kind: 'say', subject: 'el asa de una taza' }),
      request('Dibujar el asa de una taza'))).toThrow();
  });

  it('keeps written greeting practice literal rather than writing about the word', () => {
    const result = practiceExerciseFromContext(request('Practicar el saludo hello. Solo por escrito, sin hablar.'));
    expect(result).toMatch(/^Escribir .*hello/u);
    expect(result).not.toMatch(/sobre|voz alta/u);
  });

  it('uses a concrete ancestor instead of the broad branch wording', () => {
    const result = practiceExerciseFromContext(request('', { treeTitle: 'Aprender guitarra', branchTitle: 'Practicar acordes',
      ancestorTitles: ['Cambiar de Do a Sol'], focus: undefined,
    }));
    expect(result).toMatch(/^(?:Cambiar|Tocar|Practicar) .*Do.*Sol/u);
  });

  it.each(['Doblar una esquina del papel', 'Coser una puntada con hilo blanco'])('supports an unfamiliar action with an explicit small unit: %s', (goal) => {
    expect(practiceExerciseFromContext(request(goal))).toBe(goal);
    expect(renderPracticeExercise(JSON.stringify({ kind: 'perform', subject: goal }), request(goal))).toBe(goal);
  });

  it('rejects an arbitrarily large perform payload', () => {
    expect(() => renderPracticeExercise(JSON.stringify({ kind: 'perform', subject: 'Escribir una novela de veinte capítulos' }),
      request('Escribir una novela de veinte capítulos'))).toThrow();
  });

  it('rejects identifying a named part when drawing it was requested', () => {
    expect(() => renderPracticeExercise(JSON.stringify({ kind: 'find', subject: 'el asa' }),
      request('Me cuesta dibujar el asa de la taza'))).toThrow();
  });

  it('moves past explicitly finished work even without the word now', () => {
    expect(practiceExerciseFromContext(request('Resolver 2 + 3. Ya lo resolví. Explicar cómo lo hice.')))
      .toMatch(/^Explicar .*2 \+ 3/u);
  });

  it('does not treat an entire mural as a small unit', () => {
    expect(practiceExerciseFromContext(request('Dibujar un mural'))).toBeNull();
    expect(() => renderPracticeExercise(JSON.stringify({ kind: 'perform', subject: 'Dibujar un mural' }),
      request('Dibujar un mural'))).toThrow();
  });

  it('rejects an oral model action even when it repeats the written-only condition', () => {
    expect(() => renderPracticeExercise(JSON.stringify({ kind: 'say', subject: 'hello' }),
      request('Practicar el saludo hello. Solo por escrito, sin hablar.'))).toThrow();
  });

  it('retains ancestor conditions and rejects a conflicting current action', () => {
    const context = request('Decir hello', { branchTitle: 'Practicar saludos', ancestorTitles: ['Solo por escrito, sin hablar'] });
    expect(practiceExerciseFromContext(context)).toBeNull();
    expect(() => renderPracticeExercise(JSON.stringify({ kind: 'say', subject: 'hello' }), context)).toThrow();
  });

  it('keeps unfamiliar possibly hazardous actions on the guarded model path', () => {
    expect(practiceExerciseFromContext(request('Disparar una línea de puntos'))).toBeNull();
  });

  it('starts writing the supplied textual artifact instead of writing about that artifact', () => {
    const context = request('Escribir una estrofa sobre la lluvia. Sin rima.');
    const title = renderPracticeExercise(JSON.stringify({ kind: 'write', subject: 'una estrofa sobre la lluvia' }), context);
    expect(title).toBe('Escribir un verso sobre la lluvia sin rima');
    expect(practiceExerciseFromContext(context)).toBe(title);
  });

  it('reduces a counted collection to one of its supplied small objects', () => {
    const title = practiceExerciseFromContext(request('Coser los tres botones de la camisa y después revisar las costuras.'));
    expect(title).toBe('Coser uno de los botones de la camisa');
  });

  it('accepts an explicitly bounded repetition through the model without making it a local physical-action rule', () => {
    const context = request('Golpear una vez el tambor. Solo con la mano izquierda.');
    expect(practiceExerciseFromContext(context)).toBeNull();
    expect(renderPracticeExercise(JSON.stringify({ kind: 'perform', subject: 'Golpear una vez el tambor' }), context))
      .toBe('Golpear una vez el tambor solo con la mano izquierda');
  });

  it('extracts one fold before a later action on the same named object', () => {
    expect(practiceExerciseFromContext(request('Doblar la hoja por la mitad y después abrirla.')))
      .toBe('Doblar la hoja por la mitad');
  });

  it('asks for a practice detail when both improvement and its subject are unspecified', () => {
    expect(needsPracticeDetail(request('Quiero mejorar pero no sé qué practicar'))).toBe(true);
    expect(needsPracticeDetail(request('Quiero mejorar la puntada pero no sé qué practicar'))).toBe(false);
  });

  it('keeps the requested written observation after a represented reading and literal statements', () => {
    expect(practiceExerciseFromContext(request('Leer x = 2; luego x = x + 1. Anotar qué hace la segunda línea.', {
      existingStepTitles: ['Leer x = 2'],
    }))).toBe('Anotar qué hace la segunda línea');
  });

  it('preserves inline pace and body-side conditions on both local and model paths', () => {
    const context = request('Play the notes C, D and E slowly with my right hand', {
      language: 'en', treeTitle: 'Learn piano', branchTitle: 'Learn piano',
    });
    expect(practiceExerciseFromContext(context)).toBe('Play the notes C, D and E slowly with my right hand');
    const rendered = renderPracticeExercise(JSON.stringify({ kind: 'play', subject: 'C, D and E' }), context);
    expect(rendered).toContain('slowly');
    expect(rendered).toContain('with my right hand');
  });

  it('retains inline manner and tool conditions outside music', () => {
    const context = request('Trazar una línea despacio con el lápiz rojo');
    const rendered = renderPracticeExercise(JSON.stringify({ kind: 'draw', subject: 'una línea' }), context);
    expect(rendered).toContain('despacio');
    expect(rendered).toContain('con el lápiz rojo');
  });

  it('keeps a comparison within the supplied example setting', () => {
    const title = practiceExerciseFromContext(request('Distinguir receipt e invoice en un ejemplo de una tienda'));
    expect(title).toContain('receipt');
    expect(title).toContain('invoice');
    expect(title).toContain('en un ejemplo de una tienda');
  });

  it('does not replace practice difficulty with an unsolicited explanation', () => {
    const context = request('I keep forgetting the C major chord.', { language: 'en', treeTitle: 'Learn piano', branchTitle: 'Chords' });
    expect(() => renderPracticeExercise(JSON.stringify({ kind: 'explain', subject: 'the C major chord' }), context)).toThrow();
  });

  it('keeps a terminal manner adverb when selecting a model object', () => {
    const title = renderPracticeExercise(JSON.stringify({ kind: 'draw', subject: 'una línea' }), request('Trazar una línea despacio'));
    expect(title).toContain('despacio');
  });

  it('does not consume the object and following purpose as part of a leading spoken manner', () => {
    const context = request('Pronunciar en voz alta ship y sheep y distinguir sus vocales');
    expect(practiceExerciseFromContext(context)).toBe('Decir ship y sheep en voz alta');
    expect(renderPracticeExercise(JSON.stringify({ kind: 'say', subject: 'ship y sheep' }), context))
      .toBe('Decir ship y sheep en voz alta');
  });
});
