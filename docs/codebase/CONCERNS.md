# Riesgos y asuntos pendientes

## 1. Riesgos principales

| Severidad | Asunto | Evidencia | Impacto | Acción sugerida |
|-----------|--------|-----------|---------|-----------------|
| Alta | `queryPrefix` no pagina DynamoDB | `lambda/db.ts`, `handlers/family.ts` | Export o purge puede omitir datos después de 1 MB | Recorrer `LastEvaluatedKey` y probar particiones multipágina |
| Alta | Borrado de menor no reintenta `BatchWrite.UnprocessedItems` | `lambda/handlers/family.ts` | Puede confirmar borrado dejando registros o reservas | Reintentar con backoff y verificar ausencia antes de responder |
| Alta | Atomicidad de invitaciones/límites concurrentes incompleta | `family.ts`, `friends.ts`, `docs/architecture.md` | Doble canje o límites superados bajo carrera | Llevar checks y consumo de código a `TransactWrite` condicional |
| Alta antes de go-live | No hay alarmas ni alertas | `lib/roadmap-stack.ts`, `docs/architecture.md` | Fallos reales dependerían de revisión manual | Definir SLOs, alarms y destino de notificación |
| Media | Sync ejecuta hasta 100 puts secuenciales | `lambda/handlers/sync.ts` | Latencia elevada y riesgo de timeout | Paralelismo acotado o diseño batch manteniendo LWW |
| Media | Lecturas N+1 de perfiles | `handlers/me.ts`, `handlers/friends.ts` | Más latencia/costo con listas grandes | BatchGet y ensamblado en memoria |
| Media | Dos archivos CDK/IAM superan ~800/1000 líneas | `lib/*.ts` | Cambios de infraestructura difíciles de revisar | Separar stacks, roles y tiers en módulos |
| Media | Toolchain de formato no se aplica en scripts | `package.json`, `.prettierrc` | Drift de estilo | Declarar Prettier y `format:check`, o eliminar config huérfana |
| Baja | Sin coverage threshold | `vitest.config.ts` | No hay señal cuantitativa contra regresión | Incorporar coverage por áreas críticas |

## 2. Deuda técnica

| Deuda | Por qué existe | Dónde | Riesgo | Mejora |
|-------|----------------|-------|--------|--------|
| IDs/ARNs de cuenta incorporados al bootstrap | Scripts están bloqueados deliberadamente a una cuenta | `bin/roadmap.ts`, `scripts/aws-*.ps1` | Baja portabilidad y rotación manual | Extraer un config revisable manteniendo guards |
| Lógica de IAM muy concentrada | CloudFormation requiere muchos permisos granulares | `lib/stage-policies.ts` | Cambios frágiles y policy-size pressure | Separar builders por servicio/tier |
| Stack multifunción | Tres stacks y muchos roles en un archivo | `lib/roadmap-stack.ts` | Onboarding/review lentos | Un archivo por stack/construct |
| Advisory de tooling upstream | CDK empaqueta una dependencia vulnerable sin fix disponible | `SECURITY.md`, lockfile | Riesgo de desarrollo, no de Lambda | Actualizar CDK cuando exista versión corregida |
| Contratos vendorizados | Repositorios separados requieren copia | `shared/` | Riesgo de drift | Mantener gate; evaluar paquete sólo si simplifica ownership |

## 3. Seguridad

| Riesgo | Categoría | Mitigación actual | Brecha |
|--------|-----------|-------------------|--------|
| Autorización rota | OWASP A01 | JWT + perfil/relaciones desde tabla + 404 opaco | Requiere mantener matriz y pruebas al añadir rutas |
| Adivinación de códigos | OWASP A07 | RNG criptográfico, TTL y 5 fallos/hora | Bucket horario simple; sin señal/alarma |
| Despliegue con privilegios excesivos | N/A | OIDC, roles/stages, boundaries, policies con tests | Misma cuenta: execution policies son frontera crítica |
| Cleanup smoke operado directamente | N/A | MFA, stage role, guards de script | IAM no fuerza prefijo username/sub; está documentado |
| Etiquetado ACM no atómico | N/A | Dominios/nombres cerrados, deny export, inventario | Riesgo residual aceptado en cuenta compartida |
| Tooling CDK vulnerable upstream | N/A | `npm ci --ignore-scripts`, sin credenciales al instalar | Pendiente upgrade oficial |

No se encontraron secretos comprometidos. Los identificadores AWS almacenados
son metadatos operativos, no credenciales.

## 4. Rendimiento y escalamiento

| Asunto | Síntoma actual | Límite/riesgo | Recomendación |
|--------|----------------|---------------|---------------|
| Push secuencial | Una llamada DynamoDB por registro | 100 registros, Lambda 15 s | Concurrencia acotada y métricas de duración |
| N+1 en listas | Query de edges seguida de Gets | Hasta 50 amistades | BatchGet |
| Change feed | Página fija 200 + cursor por GSI | Hot partition por usuario muy activo | Medir consumo/latencia antes de cambiar |
| Export/purge de menor | `queryPrefix` devuelve una sola página | Truncamiento al superar 1 MB | Paginar y verificar completitud |
| Lambda router única | Todos los casos de uso comparten función | Cold start/bundle común; blast radius | Mantener mientras volumen sea bajo, medir antes de dividir |

No existen load tests ni métricas runtime para confirmar el punto de saturación.

## 5. Áreas frágiles y churn

| Área | Señal | Por qué importa | Estrategia segura |
|------|-------|-----------------|-------------------|
| `test/ci-bootstrap.test.ts` | 9 cambios/90 días | Codifica IAM/OIDC detallado | Cambiar junto con synth/policy review |
| `test/bootstrap-template.test.ts` | 8 | Bootstrap y scripts destructivos | Validar fases contra AWS falso |
| `lib/stage-policies.ts` | 8 | Frontera de privilegios | Revisar diff de policy y tamaño |
| `.github/workflows/dns-cutover.yml` | 5 | Mutación DNS productiva | Mantener plan/apply y doble aprobación |
| `lib/roadmap-stack.ts` | 5 | Topología completa | Ejecutar tests de infra/hosting/CI |
| `.github/workflows/deploy.yml` | 4 | Promoción y releases | Probar invariantes y dry synth |

## 6. Intención frente a realidad

- La arquitectura descrita en `README.md` y `docs/architecture.md` coincide con
  el código en sus componentes principales.
- Los ocho parámetros SSM declarados existen como cinco parámetros del Backend
  y tres del Hosting.
- Producción efectivamente no crea aliases frontend apex/`www` en el stack
  ordinario.
- CI real valida contratos, typecheck, tests y tres synths.
- Las divergencias principales ya están reconocidas por el propio diseño:
  observabilidad, atomicidad/límites concurrentes, entropía de contraseñas
  temporales y purga de cuentas adultas siguen siendo gates de go-live.
- Existe configuración Prettier, pero no hay herramienta/script de formato
  reproducible en el manifest.

## 7. Preguntas `[ASK USER]`

1. `[ASK USER]` ¿Esta documentación debe quedar como guía canónica mantenida en
   el repositorio o sólo como material temporal de estudio?
2. `[ASK USER]` ¿Los pendientes declarados de observabilidad, atomicidad de
   invitaciones y purga deben tratarse como bloqueantes antes del primer
   go-live?
3. `[ASK USER]` ¿Los scripts bootstrap deben seguir fijados a la cuenta actual,
   o esperas reutilizar la infraestructura en otra cuenta?
4. `[ASK USER]` ¿Quieres conservar `shared/` como copia vendorizada o evaluar
   más adelante un paquete de contratos compartido?

## 8. Evidencia

- `docs/architecture.md`
- `SECURITY.md`
- `lambda/handlers/family.ts`
- `lambda/handlers/friends.ts`
- `lambda/handlers/sync.ts`
- `lambda/handlers/me.ts`
- `lib/roadmap-stack.ts`
- `lib/stage-policies.ts`
- `vitest.config.ts`
- Historial Git de los últimos 90 días.
