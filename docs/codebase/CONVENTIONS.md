# Convenciones de código

## 1. Reglas de nombres

| Elemento | Regla observada | Ejemplo | Evidencia |
|----------|-----------------|---------|-----------|
| Archivos TS | `kebab-case.ts` | `post-confirmation.ts` | `lambda/` |
| Archivos de prueba | `<tema>.test.ts` | `routes.test.ts` | `test/` |
| Clases/interfaces/tipos | PascalCase | `RoadmapStack`, `ProfileItem` | `lib/roadmap-stack.ts`, `lambda/db.ts` |
| Funciones/variables | camelCase | `resolveCaller`, `pushSyncFor` | `lambda/` |
| Constantes globales | `SCREAMING_SNAKE_CASE` | `SCHEMA_VERSION`, `API_PATHS` | `shared/` |
| Constructs CDK | PascalCase descriptivo | `RoadmapHostingStack` | `lib/roadmap-stack.ts` |
| Recursos físicos AWS | kebab-case + stage | `roadmap-router-dev` | `lib/roadmap-stack.ts` |
| Claves DynamoDB | Prefijos mayúsculos | `USER#`, `REC#`, `CODE#` | `lambda/db.ts` |
| Paths SSM | kebab-case jerárquico | `/roadmap2u/dev/api-base-url` | `lib/roadmap-stack.ts` |

Los métodos privados de `RoadmapCiBootstrapStack` usan el modificador
`private`; no se observa prefijo `_`.

## 2. Formato y lint

- Dos espacios, UTF-8, newline final y trailing whitespace eliminado.
- TypeScript usa comillas simples.
- Prettier: ancho 100, comillas simples.
- TypeScript: `strict`, `forceConsistentCasingInFileNames`, `noEmit`.
- YAML se materializa con LF para mantener estables scripts Bash embebidos.
- No hay ESLint.
- No existe comando `format`/`lint` ni dependencia Prettier declarada.

Comandos verificables:

```powershell
npm run typecheck
npm run check
```

## 3. Imports y módulos

- El repositorio es ESM.
- Built-ins Node se importan con `node:*`.
- AWS y terceros aparecen antes que imports internos.
- `@app/*` apunta a `shared/*`; sirve para que Lambda y tests consuman los
  mismos contratos.
- Dentro de `lambda/` y `lib/` se usan rutas relativas.
- No hay archivos `index.ts` ni barrel exports.
- Los imports de tipos usan `import type` cuando el autor busca evitar runtime
  imports, aunque el uso no es uniforme en todos los archivos.

## 4. Errores, validación y logging

- Las reglas de dominio lanzan `ApiError` con un código cerrado.
- `lambda/http.ts` centraliza el mapeo a status HTTP.
- JSON inválido se convierte en `VALIDATION`.
- Errores inesperados se registran con `console.error('unhandled', error)` y
  devuelven un mensaje interno genérico.
- Denegaciones que podrían revelar existencia usan `NOT_FOUND`.
- Cognito/DynamoDB se traducen selectivamente a códigos de dominio; otros
  errores se propagan al manejador general.
- Los logs de acceso HTTP contienen request ID, route, status, tamaño y
  latencia; no contienen body ni tokens.
- Los campos privados del bosque se recortan en el servidor antes de responder.

No existe una librería de logging estructurado para Lambdas ni una política de
redacción codificada más allá de respuestas genéricas y selección de campos.

## 5. Convenciones de dominio y persistencia

- La autorización se vuelve a resolver desde DynamoDB; los claims no son la
  autoridad final.
- Los handlers reciben `Ctx` y `Deps`, lo que evita singletons rígidos en tests.
- `K` es la única fábrica de claves DynamoDB.
- Relaciones bidireccionales importantes se escriben con transacciones.
- LWW se expresa igual en contrato y condición DynamoDB.
- Los registros sincronizados nunca se borran físicamente: usan tombstones.
- `shared/` no se edita directamente; se sincroniza desde el frontend.
- Stages inválidos fallan temprano.

## 6. Convenciones de pruebas

- Todas las pruebas viven en `test/` y terminan en `.test.ts`.
- Vitest usa entorno Node y globals importados explícitamente.
- Runtime AWS se prueba con `aws-sdk-client-mock` o dependencias inyectadas.
- CDK se verifica con `aws-cdk-lib/assertions`.
- Workflows y políticas también tienen pruebas estructurales/textuales.
- Scripts PowerShell se ejecutan contra un `aws` falso en directorios
  temporales.
- No hay threshold de coverage ni reporte de coverage configurado.

## 7. Evidencia

- `.editorconfig`
- `.gitattributes`
- `.prettierrc`
- `tsconfig.json`
- `package.json`
- `vitest.config.ts`
- `lambda/http.ts`
- `lambda/db.ts`
- `shared/api/contracts.ts`
- `test/handlers.test.ts`
- `test/infra.test.ts`
