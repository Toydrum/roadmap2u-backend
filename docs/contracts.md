# Contratos compartidos con el frontend

## Regla de propiedad

El repositorio frontend `Toydrum/RoadMap2U` es la única fuente de verdad del contrato. Este backend conserva una copia vendorizada para poder compilar Lambdas de forma reproducible, pero `shared/` **no se edita directamente**.

| Fuente en `RoadMap2U` | Copia en este repositorio | Responsabilidad |
|---|---|---|
| `src/app/core/api/contracts.ts` | `shared/api/contracts.ts` | rutas, requests, responses, errores y límites |
| `src/app/core/db/schema.ts` | `shared/db/schema.ts` | entidades sincronizables y `SCHEMA_VERSION` |
| `src/app/core/auth/auth-types.ts` | `shared/auth/auth-types.ts` | tipos de identidad, username y contraseña |

El mock del frontend sigue siendo la especificación ejecutable del comportamiento. Un cambio de shape debe empezar allí y hacer visible cualquier incompatibilidad mediante TypeScript y tests.

## Layout requerido

Para el desarrollo y CI del backend, ambos checkouts deben ser hermanos:

```text
<workspace>/
├── RoadMap2U/
│   └── src/app/core/...
└── roadmap2u-backend/
    └── shared/...
```

La prueba `test/contracts-parity.test.ts` falla si no encuentra el frontend; no omite silenciosamente el control. Si el checkout vive en otra ruta, apunta la variable de proceso a su raíz:

```powershell
$env:ROADMAP2U_FRONTEND_PATH = 'C:\ruta\a\RoadMap2U'
npm test -- test/contracts-parity.test.ts
```

En bash:

```bash
ROADMAP2U_FRONTEND_PATH=/ruta/a/RoadMap2U npm test -- test/contracts-parity.test.ts
```

## Sincronización autorizada

Después de cambiar y validar primero el frontend, desde la raíz del backend ejecuta:

```powershell
node scripts/sync-contracts.mjs
npm test -- test/contracts-parity.test.ts
npm run typecheck
npm test
```

`scripts/sync-contracts.mjs` comprueba que existan las tres fuentes antes de copiar. El diff resultante debe mostrar únicamente los cambios contractuales esperados. Nunca uses una copia manual como sustituto de este ritual.

## Prueba de deriva

La paridad compara bytes, no tipos estructuralmente equivalentes. Por ello detecta también un archivo incompleto, una constante distinta o una actualización aplicada solo a un repositorio.

El gate es obligatorio en pull requests y despliegues. CI hace checkout de frontend y backend como directorios hermanos, instala con lockfile y ejecuta la prueba antes del synth/deploy.

Si falla:

1. confirma que el frontend está en el SHA esperado;
2. decide si el cambio pertenece realmente al contrato fuente;
3. si pertenece, integra y prueba primero el frontend;
4. sincroniza las tres copias con el script;
5. adapta handlers/tests del backend en el mismo cambio;
6. vuelve a ejecutar paridad, typecheck y toda la suite.

No resuelvas la falla editando el test, omitiendo el checkout o modificando solo `shared/`.

## Hash conjunto

`scripts/contracts-hash.mjs` calcula un SHA-256 determinista sobre los tres archivos, en orden fijo. Incluye el nombre relativo y delimitadores nulos antes de cada contenido, evitando ambigüedad entre concatenaciones.

Para que Windows y Linux produzcan la misma evidencia, el hash normaliza únicamente finales de línea CRLF a LF. La prueba de deriva sigue siendo byte a byte y, por tanto, no relaja la obligación de vendorizar copias exactas.

```powershell
node scripts/contracts-hash.mjs
```

El hash se publica en `/roadmap2u/{stage}/contract-hash`. Durante el build AWS, el frontend calcula el hash de sus archivos fuente y debe compararlo con SSM. Un mismatch detiene el build: no se permite publicar un cliente cuyo contrato no corresponda al backend desplegado.

El hash no es un secreto ni reemplaza el versionado semántico; es una evidencia exacta de paridad.

## Evolución segura

Secuencia obligatoria para un cambio:

1. Modificar el contrato y el mock en `RoadMap2U`.
2. Actualizar tests del frontend y comprobar el comportamiento local-first.
3. Integrar ese SHA en la rama que consumirá backend CI.
4. Sincronizar `shared/` mediante el script.
5. Adaptar Lambda, persistencia, permisos y tests.
6. Verificar paridad byte a byte y hash.
7. Desplegar/promover backend antes de construir el frontend dependiente.
8. Construir frontend para el mismo stage y comprobar el hash leído de SSM.

Para cambios compatibles, el backend acepta los seis stores `trees`, `nodes`, `checkins`, `sessions`, `harvests` y `preserves`. Una petición con `schemaVersion > SCHEMA_VERSION` se rechaza con `SYNC_TOO_OLD`; ignorar ese techo permitiría almacenar datos que el servidor no entiende.

## Recuperación ante un contrato incorrecto

Detén promociones y fija `AWS_DEPLOY_ENABLED=false`. Identifica el último SHA cuyo hash sea el registrado como exitoso en el ambiente anterior. Revierte o corrige primero la fuente del frontend, resincroniza el backend y vuelve a ejecutar todos los gates. No sobrescribas manualmente el parámetro SSM para hacer coincidir un binario incorrecto.
