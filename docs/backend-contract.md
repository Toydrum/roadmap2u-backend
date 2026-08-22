# Contrato funcional del backend

Los tipos normativos son las copias vendorizadas de [`shared/api/contracts.ts`](../shared/api/contracts.ts), [`shared/db/schema.ts`](../shared/db/schema.ts) y [`shared/auth/auth-types.ts`](../shared/auth/auth-types.ts). Su fuente de verdad está en `src/app/core/` del repositorio frontend. Este documento explica la semántica; si una descripción contradice los tipos, primero corrige la fuente del frontend y sigue el proceso de [contratos](contracts.md).

## Principios

1. **Local-first.** IndexedDB es la copia de trabajo del dispositivo; AWS aporta identidad, relaciones y sincronización por registro.
2. **Autorización desde datos.** La Lambda resuelve perfil y relaciones en DynamoDB en cada operación relevante. Los claims del token son defensa adicional, no la verdad única.
3. **Sin descubrimiento.** No hay búsqueda pública ni endpoint de disponibilidad de username. Una lectura de bosque denegada responde `NOT_FOUND`, evitando confirmar que el recurso existe.
4. **Privacidad en servidor.** La Lambda elimina campos privados antes de responder. Check-ins, sesiones, harvests, preserves y settings nunca se entregan en una visita.
5. **Mecánicas sin vergüenza.** Rechazar amistad es silencioso; las solicitudes expiran sin notificación de rechazo.
6. **Paridad con el mock.** El mock del frontend es la especificación ejecutable y debe cambiar antes o junto con el contrato fuente.

## Identidad Cognito

- Inicio de sesión únicamente por `username`, normalizado y único; email es atributo opcional/verificable, no alias de acceso.
- App client público sin secret, con SRP y refresh; no Hosted UI ni OAuth.
- Verificación y recuperación por código.
- Política de contraseña tomada de `PASSWORD_POLICY`.
- `custom:accountType` vale `adult` o `minor` y solo lo escribe el backend.
- Self-signup crea adultos; el trigger post-confirmation crea su perfil.
- Los menores se crean por `POST /family/children`, sin correo, y reciben una contraseña temporal mostrada una vez.
- La reserva de username se escribe con condición de inexistencia. Una carrera no puede sobrescribir una reserva previa; el segundo intento falla como username ocupado.

La identidad no usa email como login porque eso rompería la paridad con el cliente username-only y complicaría las cuentas de menores sin email.

## Perfiles, familia y amistades

Existen dos tipos de cuenta, `adult` y `minor`; “teen” es un estado de producto, no otro tipo. En menores, `socialEnabled=false` significa child y oculta/bloquea toda superficie de amistad; `true` habilita amistades y visitas bajo supervisión. Adultos siempre son sociales.

Un vínculo de guardián puede ser:

- `created`: el adulto creó la cuenta del menor y puede renombrar, restablecer contraseña, cambiar el gate social y ejecutar borrado con exportación previa;
- `invited`: la cuenta existente aceptó el vínculo; permite ver/editar el bosque y supervisar amistades, pero no administrar la identidad.

El último vínculo de una cuenta de menor `created` no puede quitarse (`LAST_GUARDIAN`). Los límites definidos en `LIMITS` son: 2 guardianes por menor, 8 menores por guardián, 50 amistades, 100 registros por push y 5 canjes de código fallidos por hora.

Solo un guardián cuyo vínculo `created` siga activo puede emitir una invitación `coGuardian`; el canje vuelve a comprobar ese vínculo antes de crear la delegación. Un guardián `invited` no puede elevar a otro adulto a `created`.

Las acciones que amplían la superficie social aplican `socialEnabled`: obtener/rotar código exige al caller habilitado y crear/aceptar exige a ambos participantes habilitados. Listar relaciones existentes, rechazar/cancelar solicitudes y eliminar amistades siguen disponibles como reducción o privacidad aunque el gate social esté apagado. Con `capabilityMode=enforce`, obtener/rotar código y crear/aceptar relaciones requieren capability `social`; las mutaciones fijan `ACCESS.revision`/vigencia y revalidan perfiles dentro de la transacción. Al crear una solicitud se detecta también una solicitud pendiente en sentido inverso: ambas direcciones representan el mismo conflicto y responden `CONFLICT`. La condición de escritura debe seguir evitando el doble submit concurrente.

## Matriz de visibilidad

| Actor → objetivo | Bosque | Campos privados de nodos | Check-ins/sesiones/pantry | Editar | Identidad |
|---|---|---|---|---|---|
| propia cuenta | completo | sí | sí | sí | propia |
| guardián → menor vinculado | completo | sí | nunca | sí | solo vínculo `created` |
| menor → guardián | recortado | no | nunca | no | no |
| amistades con social habilitado en ambos | recortado | no | nunca | no | no |
| social deshabilitado → no familiar | nada | — | — | — | — |
| extraño | `NOT_FOUND` | — | — | — | — |

“Recortado” elimina en servidor notas, trigger, fecha objetivo y otros campos de atención/rutina marcados por el contrato; excluye archivados y tombstones. Las visitas usan clima neutral porque las emociones son privadas.

## Superficie HTTP

La API usa JSON bajo `${apiBaseUrl}/v1` y exige `Authorization: Bearer <idToken>`. `apiBaseUrl` nunca contiene `/v1`. El authorizer JWT valida issuer/audience y el router aplica autorización de dominio.

| Grupo | Operaciones |
|---|---|
| perfil | leer `/me`, cambiar display name |
| familia | crear/administrar menores, exportar/borrar, administrar vínculos e invitaciones, supervisar amistades del menor |
| amistades | listar, emitir/rotar código, crear/aceptar/rechazar/cancelar solicitud, eliminar amistad |
| bosques | visitar el bosque autorizado de otra cuenta |
| sync | leer change feed, push propio y push de guardián hacia un menor |

Las rutas literales y dinámicas viven en `API_PATHS`; el router y el transporte cliente deben cubrirlas todas. Los errores viajan como `{ "error": { "code": "...", "message": "..." } }`. Los códigos en mayúsculas son del servidor; `offline`, `server` y `unknown` los crea el cliente.

## Sincronización

Los seis stores admitidos son:

```text
trees | nodes | checkins | sessions | harvests | preserves
```

Settings son preferencias de dispositivo y no se sincronizan. Cada push incluye `schemaVersion`; si es mayor que el `SCHEMA_VERSION` que entiende el backend, toda la petición se rechaza con `SYNC_TOO_OLD`.

La resolución LWW es única para cliente, mock y servidor:

1. mayor `rev` gana;
2. con igual `rev`, mayor `updatedAt` gana;
3. un empate exacto conserva la copia ya almacenada.

Un registro rechazado por `STALE_REV` devuelve la copia ganadora en `serverRecords`. Los tombstones viajan como registros normales y no se eliminan físicamente. El change feed se ordena por hora de recepción del servidor, no por reloj del cliente, y presenta un cursor opaco.

## Persistencia DynamoDB

Cada stage tiene su propia tabla single-table, on-demand, con TTL y dos GSIs. Los nombres exactos incorporan el stage.

| Entidad | PK | SK | Observación |
|---|---|---|---|
| Profile | `USER#<id>` | `PROFILE` | identidad de autorización |
| Username guard | `UNIQ#USERNAME#<lower>` | `UNIQ` | put/transacción condicional |
| GuardianLink | `USER#<minor>` | `GUARDIAN#<guardian>` | GSI para dirección inversa |
| Friendship | `USER#<a>` | `FRIEND#<b>` | dos espejos atómicos |
| FriendRequest | `USER#<to>` | `FREQ#<id>` | GSI saliente y TTL |
| Códigos | `CODE#F#...` o `CODE#G#...` | `CODE` | TTL y canje limitado |
| Record | `USER#<owner>` | `REC#<store>#<id>` | GSI de cambios por tiempo de servidor |

La condición de un record push refleja exactamente LWW. La unicidad de username y las escrituras que deban mantener dos lados de una relación no dependen de una lectura previa sin condición.

## Reglas críticas de autorización

- Una ruta protegida requiere token válido y perfil activo.
- Administrar la identidad de un menor requiere vínculo `created`; co-gardening admite ambos tipos.
- Aceptar una solicitud requiere ser destinatario; cancelarla requiere ser remitente.
- Los límites de amistad se comprueban al solicitar y al aceptar.
- Leer bosque de amistad requiere `socialEnabled` en ambos perfiles; con `capabilityMode=enforce`, la capability `social` se exige al visitante, no al dueño visitado.
- Push hacia otra cuenta requiere que el caller sea guardián activo del menor.
- Los parámetros de path prevalecen sobre query/body cuando el router los combina.

## Cobertura y cambios

Vitest cubre paridad de rutas, matriz de denegaciones, stripping, LWW, techo de schema, seis stores, `LAST_GUARDIAN`, expiración/rate limit de códigos, gate social, solicitud inversa y reserva condicional de username. El número de tests puede crecer; el criterio no es una cifra fija sino que toda la suite, typecheck y synth de cada stage estén verdes.

Antes de desplegar cualquier modificación contractual, sigue [contracts.md](contracts.md) y el [runbook de deploy](runbooks/deploy.md).
