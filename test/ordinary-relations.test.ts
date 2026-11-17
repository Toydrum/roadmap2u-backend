import { describe, expect, it } from 'vitest';
import type { StepSuggestionsRequest } from '@app/api/contracts';
import { ordinaryContextNeeded, ordinaryObjectiveFromContext, ordinaryObjectiveKey, renderOrdinaryObjective } from '../lambda/ai/ordinary-objectives';

function context(focus: string, overrides: Partial<StepSuggestionsRequest> = {}): StepSuggestionsRequest {
  return { language: 'es', treeTitle: 'Ordenar mi espacio', branchTitle: 'Ordenar mi espacio',
    ancestorTitles: [], existingStepTitles: [], maxSuggestions: 1, focus, ...overrides };
}
function render(request: StepSuggestionsRequest, action: string, object: string, target?: string): string {
  return renderOrdinaryObjective(JSON.stringify({ action, object, ...(target ? { target } : {}) }), request);
}

describe('ordinary action relationships', () => {
  it('keeps the source and the chosen destination in their roles', () => {
    const request = context('La camiseta está en el suelo. No tengo cesto; usar la repisa.');
    expect(ordinaryObjectiveFromContext(request)).toBe('Poner la camiseta en la repisa');
    expect(render(request, 'Poner', 'la camiseta', 'en la repisa')).toBe('Poner la camiseta en la repisa');
    expect(() => render(request, 'Retirar', 'la camiseta', 'de la repisa')).toThrow();
  });

  it.each([
    ['La brocha va en la caja. El lápiz va en el cajón. Guardar el lápiz.', 'Guardar el lápiz en el cajón'],
    ['El cargador va en la bolsa. La libreta va en la repisa. Guardar la libreta.', 'Guardar la libreta en la repisa'],
  ])('selects the current object and its own destination from all statements (%s)', (focus, title) => {
    const request = context(focus);
    expect(ordinaryObjectiveFromContext(request)).toBe(title);
    expect(() => render(request, 'Guardar', 'la brocha', 'en la caja')).toThrow();
  });

  it('rejects the destination assigned to a different object even when every word exists', () => {
    const request = context('La brocha va en la caja. El lápiz va en el cajón. Guardar el lápiz.');
    expect(() => render(request, 'Guardar', 'el lápiz', 'en la caja')).toThrow();
  });

  it('asks for a book destination instead of borrowing the cup location', () => {
    const request = context('El libro está en la mesa. La taza está en la caja. Guardar el libro.', { branchTitle: 'Guardar el libro' });
    expect(ordinaryContextNeeded(request)).toBe('destination');
    expect(() => render(request, 'Guardar', 'el libro', 'en la caja')).toThrow();
  });

  it.each([
    ['No hay libros en el suelo. Los zapatos están junto a la puerta.', 'Retirar', 'los libros', 'del suelo'],
    ['La camiseta está en el suelo. No tengo cesto; usar la repisa.', 'Poner', 'la camiseta', 'en el cesto'],
    ['La caja está junto a la puerta. La caja no está disponible.', 'Poner', 'un objeto', 'en la caja'],
  ])('does not ground facts from absence or unavailable statements (%s)', (focus, action, object, target) => {
    expect(() => render(context(focus), action, object, target)).toThrow();
  });

  it('allows removal from a stated source without inventing a destination', () => {
    const request = context('No hay libros en el suelo. Los zapatos están junto a la puerta.');
    expect(render(request, 'Retirar', 'los zapatos', 'de junto a la puerta')).toBe('Retirar los zapatos de junto a la puerta');
  });

  it('resolves a destination pronoun only when there is one unambiguous subject', () => {
    const request = context('La brocha está sobre la repisa. Guárdala en la caja azul.');
    expect(ordinaryObjectiveFromContext(request)).toBe('Guardar la brocha en la caja azul');
  });

  it('does not guess the object for a pronoun with two possible subjects', () => {
    const request = context('La brocha está en la mesa. La regla está en la silla. Guárdala en la caja.');
    expect(ordinaryObjectiveFromContext(request)).toBeNull();
  });

  it('retains a current writing action after a completed preparation', () => {
    const request = context('Ya redacté el asunto del correo. Ahora escribir el saludo.', { existingStepTitles: ['Escribir el asunto del correo'] });
    expect(ordinaryObjectiveFromContext(request)).toBe('Escribir el saludo');
    expect(() => render(request, 'Redactar', 'el asunto', 'del correo')).toThrow();
  });

  it('uses equivalent transfer verbs to detect an already represented action', () => {
    const request = context('El lápiz va en el cajón. Guardar el lápiz.');
    expect(ordinaryObjectiveKey('Colocar el lápiz en el cajón.', request)).toBe(ordinaryObjectiveKey('Guardar el lápiz en el cajón', request));
  });

  it('keeps an explicit restriction when generating locally or defers it', () => {
    const request = context('La brocha va en la caja. Guardar la brocha sin tocar la pintura.');
    const title = ordinaryObjectiveFromContext(request);
    expect(title === null || title.includes('sin tocar la pintura')).toBe(true);
  });

  it('rejects a second action hidden inside a grounded object field', () => {
    const request = context('Escribir el informe y revisar todo el texto');
    expect(() => render(request, 'Escribir', 'el informe y revisar todo el texto')).toThrow();
  });

  it('supports the same object/location relationships in English', () => {
    const request = context('The pen goes in the drawer. The brush goes in the box. Put away the pen.', { language: 'en' });
    expect(ordinaryObjectiveFromContext(request)).toBe('Put away the pen in the drawer');
    expect(() => render(request, 'Put', 'the pen', 'in the box')).toThrow();
  });

  it('keeps a named source distinct from a destination in English', () => {
    const request = context('The scarf is on the chair. Use the shelf.', { language: 'en' });
    expect(ordinaryObjectiveFromContext(request)).toBe('Put the scarf on the shelf');
    expect(() => render(request, 'Remove', 'the scarf', 'from the shelf')).toThrow();
  });

  it('uses the branch intention with relations supplied in ancestors and focus', () => {
    const request = context('La taza está en la caja.', { branchTitle: 'Guardar el libro', ancestorTitles: ['El libro está en la mesa'] });
    expect(ordinaryContextNeeded(request)).toBe('destination');
  });

  it('does not use a multi-step or oversized object as a single local move', () => {
    const request = context('Los libros van en la caja. Guardar todos los libros.');
    expect(ordinaryObjectiveFromContext(request)).toBeNull();
  });

  it('preserves spatial relations, not merely the destination noun', () => {
    const request = context('La bandeja va debajo de la mesa. Guardar la bandeja.');
    expect(() => render(request, 'Poner', 'la bandeja', 'sobre la mesa')).toThrow();
  });

  it('does not infer a movement if the chosen resource is needed for a different action', () => {
    const request = context('La camiseta está en el suelo. Usar la plancha.', { treeTitle: 'Planchar la ropa', branchTitle: 'Planchar la camiseta' });
    expect(ordinaryObjectiveFromContext(request)).toBeNull();
  });

  it('rejects a larger or compound objective even if its words are supplied', () => {
    const request = context('Escribir el informe completo y revisar todo el texto');
    expect(() => render(request, 'Escribir', 'el informe completo')).toThrow();
  });

  it('keeps explicit restrictions from later sentences without needing model repetition', () => {
    const request = context('La brocha va en la caja. Guardar la brocha. Sin tocar la pintura.');
    expect(render(request, 'Guardar', 'la brocha', 'en la caja')).toBe('Guardar la brocha en la caja, sin tocar la pintura');
  });

  it('keeps more than one explicitly stated restriction', () => {
    const request = context('El sobre va en la caja. Guardar el sobre. Sin doblarlo. Sin abrirlo.');
    expect(render(request, 'Guardar', 'el sobre', 'en la caja')).toBe('Guardar el sobre en la caja, sin doblarlo, sin abrirlo');
  });

  it('keeps an English medium limitation', () => {
    const request = context('Now write a greeting. Only in pencil.', { language: 'en' });
    expect(render(request, 'Write', 'a greeting')).toBe('Write a greeting, only in pencil');
  });

  it('rejects a contradictory action instead of attaching the prohibition to it', () => {
    const request = context('Doblar la hoja. Sin doblar la hoja.');
    expect(() => render(request, 'Doblar', 'la hoja')).toThrow();
  });

  it('does not silently drop a restriction when the complete title is too long', () => {
    const request = context('El objeto decorativo va en la caja. Sin tocar la pintura todavía húmeda del borde.');
    expect(() => render(request, 'Guardar', 'el objeto decorativo', 'en la caja')).toThrow();
  });

  it('asks for the destination even if only the other object has a known location', () => {
    const request = context('La taza está en la caja. Guardar el libro.');
    expect(ordinaryContextNeeded(request)).toBe('destination');
  });

  it('does not treat an incomplete saving action as a complete objective', () => {
    const request = context('El libro está en la mesa. Guardar el libro.');
    expect(() => render(request, 'Guardar', 'el libro')).toThrow();
  });

  it('retains spatial prepositions for source validation too', () => {
    const request = context('La caja está debajo de la mesa. El vaso está encima de la mesa. Retirar la caja.');
    expect(() => render(request, 'Retirar', 'la caja', 'de encima de la mesa')).toThrow();
  });

  it('does not convert an absent object into a generic item', () => {
    const request = context('No hay cajas en la mesa. Guardar una caja.');
    expect(() => render(request, 'Guardar', 'una caja', 'en la mesa')).toThrow();
  });

  it('rejects a changed operation even when object and place are grounded', () => {
    const request = context('El lápiz va en el cajón. Guardar el lápiz.');
    expect(() => render(request, 'Romper', 'el lápiz', 'en el cajón')).toThrow();
  });

  it('keeps a positive preservation instruction from later context', () => {
    const request = context('Ahora escribir una frase en la copia. Conservar el archivo original.');
    expect(render(request, 'Escribir', 'una frase', 'en la copia')).toBe('Escribir una frase en la copia, conservar el archivo original');
  });

  it('withholds a destructive operation on the object that must be kept', () => {
    const request = context('El archivo original está en la carpeta. Conservar el archivo original.');
    expect(() => render(request, 'Borrar', 'el archivo original', 'de la carpeta')).toThrow();
  });

  it('does not silently drop an unparsed preservation condition from the local shortcut', () => {
    const request = context('La regla va en la caja. Guardar la regla. Mantener las etiquetas visibles.');
    expect(ordinaryObjectiveFromContext(request)).toBeNull();
  });

  it('keeps the English preservation condition', () => {
    const request = context('Now write one sentence in the copy. Keep the original file.', { language: 'en' });
    expect(render(request, 'Write', 'one sentence', 'in the copy')).toBe('Write one sentence in the copy, keep the original file');
  });

  it.each([
    ['El cuadro está en la mesa. Usar guantes.', 'Guardar el cuadro', 'guantes'],
    ['El vaso está en la mesa. Usar pinzas.', 'Guardar el vaso', 'pinzas'],
  ])('does not turn a named tool into a destination (%s)', (focus, branchTitle, tool) => {
    const request = context(focus, { branchTitle });
    expect(ordinaryObjectiveFromContext(request)).toBeNull();
    expect(ordinaryContextNeeded(request)).toBe('destination');
    expect(() => render(request, 'Guardar', branchTitle.replace('Guardar ', ''), `en ${tool}`)).toThrow();
  });

  it('accepts a destination explicitly designated as such without a known-place noun', () => {
    const request = context('El cuadro está en la mesa. Usar el módulo lateral como destino.', { branchTitle: 'Guardar el cuadro' });
    expect(ordinaryObjectiveFromContext(request)).toBe('Guardar el cuadro en el módulo lateral');
  });

  it('keeps a supplied tool as a condition when the destination is separately known', () => {
    const request = context('El cuadro va en el armario. Guardar el cuadro. Usar guantes.');
    expect(render(request, 'Guardar', 'el cuadro', 'en el armario')).toBe('Guardar el cuadro en el armario, usando guantes');
  });

  it('recognizes recording aliases as the same represented action', () => {
    const request = context('Anotar agua y después gas en la columna Servicios.');
    expect(ordinaryObjectiveKey('Anotar agua en la columna Servicios', request))
      .toBe(ordinaryObjectiveKey('Registrar agua en la columna Servicios.', request));
  });

  it('continues an explicitly ordered sequence whose second item omits the verb', () => {
    const request = context('Anotar agua y después gas en la columna Servicios.', {
      branchTitle: 'Actualizar gastos', existingStepTitles: ['Registrar agua en la columna Servicios.'],
    });
    expect(ordinaryObjectiveFromContext(request)).toBe('Anotar gas en la columna Servicios');
    expect(() => render(request, 'Anotar', 'agua', 'en la columna Servicios')).toThrow();
  });

  it('uses the first item when neither ordered activity is represented', () => {
    const request = context('Anotar entrada y luego salida en el registro.');
    expect(ordinaryObjectiveFromContext(request)).toBe('Anotar entrada en el registro');
  });

  it('continues an English recording sequence using equivalent existing verbs', () => {
    const request = context('Record rent and then water in the Costs column.', {
      language: 'en', existingStepTitles: ['Log rent in the Costs column'],
    });
    expect(ordinaryObjectiveFromContext(request)).toBe('Record water in the Costs column');
  });

  it('rejects moving a named file when the original must be preserved', () => {
    const request = context('Llevar informe.pdf a la carpeta Trabajo. Conservar el archivo original.', { branchTitle: 'Preparar la entrega' });
    expect(() => render(request, 'Mover', 'informe.pdf', 'en la carpeta Trabajo')).toThrow();
    expect(render(request, 'Copiar', 'informe.pdf', 'en la carpeta Trabajo'))
      .toBe('Copiar informe.pdf en la carpeta Trabajo, conservar el archivo original');
  });

  it('supports preservation-compatible copying in English too', () => {
    const request = context('Move sketch.svg to the Design folder. Keep the original file.', { language: 'en' });
    expect(() => render(request, 'Move', 'sketch.svg', 'to the Design folder')).toThrow();
    expect(render(request, 'Copy', 'sketch.svg', 'to the Design folder'))
      .toBe('Copy sketch.svg to the Design folder, keep the original file');
  });

  it('does not allow a copy to switch to an unrelated destination', () => {
    const request = context('Llevar informe.pdf a la carpeta Trabajo. Conservar el archivo original.', { ancestorTitles: ['La carpeta Archivo está abierta'] });
    expect(() => render(request, 'Copiar', 'informe.pdf', 'en la carpeta Archivo')).toThrow();
  });

  it('treats moving off a named surface as removal without asking for a destination', () => {
    const request = context('The pen is on the workbench. Move it off the workbench.', {
      language: 'en', treeTitle: 'Organize work area', branchTitle: 'Clear the workbench',
    });
    expect(ordinaryContextNeeded(request)).toBeNull();
    expect(ordinaryObjectiveFromContext(request)).toBe('Remove the pen from the workbench');
    expect(render(request, 'Remove', 'the pen', 'from the workbench')).toBe('Remove the pen from the workbench');
  });

  it('supports an explicitly named object moved out of a container', () => {
    const request = context('The scarf is in the bag. Move the scarf out of the bag.', {
      language: 'en', branchTitle: 'Clear the bag',
    });
    expect(ordinaryContextNeeded(request)).toBeNull();
    expect(ordinaryObjectiveFromContext(request)).toBe('Remove the scarf from the bag');
  });

  it('does not resolve an ambiguous removal pronoun to either object', () => {
    const request = context('The pen is on the desk. The brush is on the desk. Move it off the desk.', {
      language: 'en', branchTitle: 'Clear the desk',
    });
    expect(ordinaryObjectiveFromContext(request)).toBeNull();
  });
});
