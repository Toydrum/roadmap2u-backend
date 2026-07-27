# Estructura del repositorio

## 1. Mapa superior

| Ruta | Responsabilidad |
|------|-----------------|
| `.github/` | Dependabot, validación, despliegue OIDC y corte DNS |
| `bin/` | Entry point de la aplicación CDK |
| `bootstrap/` | Plantillas CloudFormation revisables para el plano de control |
| `docs/` | Arquitectura, contratos y runbooks operativos |
| `lambda/` | Runtime serverless: triggers, router, autorización, handlers y datos |
| `lib/` | Stacks CDK y políticas IAM de mínimo privilegio |
| `scripts/` | Bootstrap/operaciones AWS y sincronización de contratos |
| `shared/` | Copia vendorizada de contratos normativos del frontend |
| `test/` | Suite Vitest de runtime, infraestructura, workflows y scripts |
| `cdk.out*`, `node_modules/` | Artefactos generados/instalados; no son fuente |

## 2. Puntos de entrada

| Entrada | Evento o invocador | Selección |
|---------|--------------------|-----------|
| `bin/roadmap.ts` | CDK CLI | `cdk.json` ejecuta `npx tsx bin/roadmap.ts` |
| `lambda/router.ts#handler` | HTTP API `/v1/{proxy+}` | `RoadmapStack` |
| `lambda/pre-signup.ts#handler` | Cognito PreSignUp | `RoadmapStack` |
| `lambda/post-confirmation.ts#handler` | Cognito PostConfirmation | `RoadmapStack` |
| `.github/workflows/*.yml` | Push o dispatch manual | GitHub Actions |
| `scripts/*.ps1` | Operador humano autorizado | Parámetros y confirmación explícita |
| `scripts/*.mjs` | npm/operador/CI | Scripts de contratos y plantillas |

## 3. Límites de módulos

| Límite | Contiene | No debe contener |
|--------|----------|-------------------|
| `shared/` | Tipos, constantes, rutas y schema compartidos | Implementación AWS; edición manual en backend |
| `lambda/router.ts` | Adaptación de evento HTTP y dispatch | Reglas de negocio o queries DynamoDB |
| `lambda/authz.ts` | Reglas de relación y autorización | Escrituras de dominio |
| `lambda/handlers/` | Casos de uso por perfil/familia/amigos/bosque/sync | Configuración de infraestructura |
| `lambda/db.ts` | Clientes, shapes, claves y operaciones DynamoDB | Decisiones de visibilidad/producto |
| `lib/` | Recursos AWS, IAM, stages y despliegue | Lógica de requests HTTP |
| `.github/` y `scripts/` | Orquestación operativa | Lógica de dominio del backend |
| `test/` | Verificación y dobles | Código desplegable |

## 4. Catálogo de los 65 archivos versionados

### Raíz y configuración

| Archivo | Para qué sirve |
|---------|----------------|
| `.editorconfig` | Define UTF-8, dos espacios, newline final y comillas simples en TS |
| `.gitattributes` | Fuerza LF para YAML y Bash embebido |
| `.gitignore` | Excluye dependencias, assemblies CDK, coverage, logs y `.env` |
| `.nvmrc` | Fija Node 22 |
| `.prettierrc` | Configura ancho 100 y comilla simple |
| `LICENSE` | Licencia MIT |
| `README.md` | Entrada de onboarding, ambientes, arquitectura y comandos |
| `SECURITY.md` | Canal de reporte, política de dependencias y advisory conocido |
| `cdk.json` | Declara la aplicación CDK y rutas observadas |
| `package.json` | Scripts, ranges de dependencias, Node/npm y metadatos |
| `package-lock.json` | Resolución reproducible exacta de npm |
| `tsconfig.json` | TypeScript estricto, ESM, target ES2022 y alias `@app/*` |
| `vitest.config.ts` | Descubre `test/**/*.test.ts` y resuelve `@app` |

### GitHub

| Archivo | Para qué sirve |
|---------|----------------|
| `.github/dependabot.yml` | Actualizaciones semanales de CDK y Actions |
| `.github/workflows/ci.yml` | Paridad contractual, typecheck, tests y synth de tres stages |
| `.github/workflows/deploy.yml` | Deploy/promoción/rollback de un SHA exacto con OIDC y gates |
| `.github/workflows/dns-cutover.yml` | Plan y aplicación doblemente aprobada del DNS productivo |
| `.github/workflows/oidc-preflight.yml` | Comprueba identidades OIDC sin mutar AWS |

### CDK y bootstrap

| Archivo | Para qué sirve |
|---------|----------------|
| `bin/roadmap.ts` | Valida contexto e instancia Backend, Hosting y CiBootstrap |
| `bootstrap/bootstrap-operator.template.json` | Rol temporal MFA y bucket privado para instalar el control plane |
| `bootstrap/roadmap2u-stage-bootstrap.template.json` | Plantilla base del toolkit CDK aislado |
| `bootstrap/roadmap2u-dev-bootstrap.template.json` | Toolkit materializado para `dev` |
| `bootstrap/roadmap2u-test-bootstrap.template.json` | Toolkit materializado para `test` |
| `bootstrap/roadmap2u-prod-bootstrap.template.json` | Toolkit materializado para `prod` |
| `lib/roadmap-stack.ts` | Define stacks Backend, Hosting y CiBootstrap |
| `lib/stage-policies.ts` | Construye policies IAM y permissions boundary por stage |

Cada toolkit de stage posee bucket de assets, tres roles IAM, SSM version,
Origin Access Control y log group de API. Las variantes se generan a partir de
la plantilla base mediante `scripts/render-stage-bootstrap-templates.mjs`.

### Runtime Lambda

| Archivo | Para qué sirve |
|---------|----------------|
| `lambda/router.ts` | Mapea 26 combinaciones método/ruta a handlers |
| `lambda/http.ts` | Parsea JSON y normaliza respuestas/errores HTTP |
| `lambda/authz.ts` | Resuelve caller y relaciones desde DynamoDB |
| `lambda/db.ts` | Dependencias, single-table keys, item types y comandos comunes |
| `lambda/codes.ts` | Genera códigos e invitaciones/contraseñas con RNG criptográfico |
| `lambda/pre-signup.ts` | Valida username y email antes del alta Cognito |
| `lambda/post-confirmation.ts` | Crea perfil adulto y reserva username tras confirmar |
| `lambda/handlers/me.ts` | Perfil propio y vínculos familiares |
| `lambda/handlers/family.ts` | Menores, invitaciones, export/borrado y supervisión |
| `lambda/handlers/friends.ts` | Códigos, solicitudes y relaciones de amistad |
| `lambda/handlers/forests.ts` | Snapshot completo o recortado según relación |
| `lambda/handlers/sync.ts` | Push LWW y change feed con cursor |

### Contratos vendorizados

| Archivo | Para qué sirve |
|---------|----------------|
| `shared/api/contracts.ts` | Requests, responses, rutas, errores, límites y ley LWW |
| `shared/auth/auth-types.ts` | Identidad, política de contraseña y username |
| `shared/db/schema.ts` | Entidades local-first, `SCHEMA_VERSION=12` y helpers |

La fuente de verdad está en el frontend hermano `RoadMap2U`; este backend
comprueba igualdad byte a byte.

### Scripts

| Archivo | Para qué sirve |
|---------|----------------|
| `scripts/contracts-hash.mjs` | SHA-256 determinista de los tres contratos |
| `scripts/sync-contracts.mjs` | Copia contratos desde el frontend tras validarlos |
| `scripts/render-stage-bootstrap-templates.mjs` | Materializa dev/test/prod desde la plantilla bootstrap base |
| `scripts/aws-bootstrap.ps1` | Instala operador temporal, control plane y toolkits con MFA |
| `scripts/aws-break-glass.ps1` | Vacía S3 versionado y destruye stacks dev/test de forma reanudable |
| `scripts/aws-smoke-cleanup.ps1` | Elimina un usuario smoke y su partición con verificaciones estrictas |

### Documentación operativa

| Archivo | Para qué sirve |
|---------|----------------|
| `docs/architecture.md` | Diseño AWS, stages, CI/CD, datos y riesgos de go-live |
| `docs/backend-contract.md` | Semántica de identidad, familia, amigos, sync y permisos |
| `docs/contracts.md` | Ownership, paridad, hash y evolución de contratos |
| `docs/github-aws-setup.md` | Configuración de OIDC, environments, roles y bootstrap |
| `docs/runbooks/deploy.md` | Validación, promoción, smokes, rollback y abortos |
| `docs/runbooks/dns-cutover.md` | Corte DNS productivo reversible con artefacto inmutable |
| `docs/runbooks/operations.md` | Cleanup smoke y destrucción break-glass con MFA |

### Pruebas

| Archivo | Para qué sirve |
|---------|----------------|
| `test/bin-config.test.ts` | Rechazo de synth sin stage |
| `test/bootstrap-template.test.ts` | Plantillas, operador MFA y scripts destructivos |
| `test/ci-bootstrap.test.ts` | OIDC, IAM, boundaries, DNS y scopes de release |
| `test/contracts-parity.test.ts` | Paridad byte a byte, sync y hash multiplataforma |
| `test/handlers.test.ts` | Autorización, LWW, familia, amigos y reserva username |
| `test/hosting.test.ts` | S3/CloudFront, SPA, redirect y security headers |
| `test/infra.test.ts` | Cognito, API, DynamoDB, CORS, triggers y retención |
| `test/pre-signup.test.ts` | Contrato del trigger PreSignUp |
| `test/routes.test.ts` | Paridad entre `API_PATHS` y router |
| `test/smoke-cleanup.test.ts` | Ejecución reanudable del cleanup con AWS falso |
| `test/workflows.test.ts` | Invariantes textuales de CI, deploy, OIDC y DNS |

## 5. Organización y nombres

- Archivos TypeScript y scripts: `kebab-case`.
- Handlers agrupados por feature; utilidades runtime por capa.
- Constructs principales en `PascalCase`; funciones/variables en `camelCase`.
- `@app/*` resuelve exclusivamente a `shared/*`.
- Imports internos usan rutas relativas y no existen barrel files.
- El código generado en `cdk.out*` y dependencias en `node_modules` deben
  ignorarse al estudiar convenciones o responsabilidades.

## 6. Orden recomendado para estudiar

1. `README.md` y `docs/architecture.md`.
2. `shared/api/contracts.ts` y `docs/backend-contract.md`.
3. `lambda/router.ts` → `authz.ts` → un handler → `db.ts`.
4. `lib/roadmap-stack.ts` empezando por `RoadmapStack`.
5. `lib/stage-policies.ts` y `RoadmapCiBootstrapStack`.
6. `.github/workflows/ci.yml` y después `deploy.yml`.
7. Las pruebas equivalentes a cada módulo.
8. Bootstrap, DNS y operaciones al final: son el plano más sensible.

## 7. Evidencia

- `git ls-files` — 65 archivos versionados.
- `README.md`
- `cdk.json`
- `bin/roadmap.ts`
- `lambda/router.ts`
- `lib/roadmap-stack.ts`
- `test/`
- `.gitignore`
