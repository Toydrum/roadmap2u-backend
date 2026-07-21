# Arquitectura AWS

## Objetivo y límites

Este repositorio concentra toda la infraestructura AWS de RoadMap2U y permite reproducirla por ambiente. La aplicación web continúa en su repositorio propio, pero su hosting, dominio, parámetros de runtime y roles de despliegue se modelan aquí.

La arquitectura separa bootstrap, despliegues por stage y corte DNS en ventanas aprobadas. Conservar el código o sintetizar plantillas no muta la cuenta; las escrituras ocurren únicamente mediante el operador temporal o los workflows protegidos descritos en los runbooks.

## Vista general

```mermaid
flowchart LR
    U["Navegador / PWA"] --> R53["Route 53"]
    R53 --> CF["CloudFront + HTTPS"]
    CF -->|"OAC"| S3["S3 privado y versionado"]
    U --> API["HTTP API /v1"]
    API --> JWT["Cognito JWT authorizer"]
    API --> L["Lambda router"]
    L --> DDB["DynamoDB"]
    GH["GitHub Actions"] -->|"OIDC, sin access keys"| IAM["Roles IAM por repo/stage"]
    IAM --> CF
    IAM --> S3
    IAM --> API
    SSM["SSM Parameter Store"] --> GH
```

La petición al API usa una URL base sin `/v1`; el cliente agrega esa versión al construir cada ruta. Las rutas de Angular que no corresponden a un objeto se reescriben a `index.html` en el borde, sin hacer público el bucket.

## Modelo de stages

`stage` es obligatorio y admite únicamente `dev`, `test` o `prod`. Cada recurso con nombre físico, stack y parámetro incorpora ese valor. No se comparte User Pool, tabla, API, bucket ni distribución entre ambientes.

| Propiedad | `dev` | `test` | `prod` |
|---|---|---|---|
| Frontend | `dev.roadmap2u.com` | `test.roadmap2u.com` | `roadmap2u.com` |
| API | `api.dev.roadmap2u.com` | `api.test.roadmap2u.com` | `api.roadmap2u.com` |
| CORS localhost | sí: 4200 y 8826 | sí: 4200 y 8826 | no |
| Retención al borrar stack | eliminable | eliminable | `RETAIN` |
| DynamoDB PITR / protección | según configuración no productiva | según configuración no productiva | habilitada |
| S3 versioning | habilitado | habilitado | habilitado |
| DNS frontend gestionado | sí | sí | **no inicialmente** |

Producción crea el certificado y la distribución previstos para apex/`www`, pero no crea ni actualiza sus aliases al principio. Esto evita sustituir de manera lateral el sitio que ya atiende esos nombres.

## Backend por stage

### Identidad

Cognito usa `username` como único alias de inicio de sesión. El email es un atributo opcional/verificable, no un alias de login. El app client web no tiene secret y utiliza SRP. El trigger post-confirmation reserva el username en DynamoDB mediante una escritura condicional para que dos confirmaciones concurrentes no puedan reclamar el mismo nombre.

El User Pool usa el remitente administrado por Cognito (`EmailSendingAccount: COGNITO_DEFAULT`) para verificaciones y recuperación. La arquitectura no crea identidades Amazon SES y opera sin permisos `ses:*`. HostGator continúa administrando los buzones y el correo del dominio; los MX, SPF, DKIM, DMARC y subdominios de correo quedan fuera del ownership de estos stacks. El límite predeterminado de Cognito de 50 correos diarios se considera suficiente únicamente para rollout y pruebas; superar ese volumen exige diseñar explícitamente una integración de envío con HostGator, no activar SES de forma automática.

Los atributos y la política de contraseña proceden del contrato vendorizado. Las cuentas de menores las crea exclusivamente el backend; el frontend nunca recibe permisos administrativos sobre Cognito.

### API y cómputo

HTTP API expone las rutas bajo `/v1`, con dominio propio por stage. El authorizer valida tokens Cognito antes de invocar el router Lambda. La función vuelve a resolver el perfil y las relaciones en DynamoDB: un claim no reemplaza una comprobación de autorización.

El router implementa las superficies de perfil, familia, amistades, visitas de bosques y sincronización. CORS es una allowlist cerrada por ambiente. Producción no admite localhost.

### Datos

Una tabla DynamoDB por stage usa single-table design, pago por solicitud, TTL y dos índices secundarios. Producción activa point-in-time recovery y conserva la tabla al eliminar el stack. Los registros sincronizables son `trees`, `nodes`, `checkins`, `sessions`, `harvests` y `preserves`; preferencias locales sin `rev` no se sincronizan.

La ley de resolución es LWW por `rev` y luego `updatedAt`. El backend rechaza un `schemaVersion` superior a `SCHEMA_VERSION`, conserva tombstones y trata empates exactos como victoria de la copia almacenada.

## Hosting web por stage

- Bucket S3 privado, bloqueo de acceso público y versioning.
- CloudFront accede al origen únicamente mediante OAC; no se usa website hosting de S3.
- TLS obligatorio, compresión, `index.html` como raíz y reescritura de rutas SPA.
- Headers base de seguridad servidos por CloudFront.
- Certificado ACM en `us-east-1`, región requerida por CloudFront.
- `www.roadmap2u.com` deberá responder con redirección permanente al apex una vez realizado el cutover.

### Límite de aislamiento durante el etiquetado ACM

El resource provider de CloudFormation observado en esta cuenta crea cada certificado público sin tags y después aplica `Name`, seguido por los tags de proyecto y stage. IAM no expone en `AddTagsToCertificate` una condición que relacione ese ARN recién creado con la solicitud anterior. Por ello, la concesión inicial también podría asignar uno de los dos nombres exactos del stage a otro certificado `AWS_MANAGED` completamente sin tags de la misma cuenta. La cuenta es compartida y ya contiene certificados ajenos sin tags; se acepta este riesgo residual porque el execution role es asumible únicamente por CloudFormation, los roles de GitHub no pueden invocar ACM ni asumirlo directamente, los roles runtime tienen una permissions boundary sin ACM, los dominios de emisión están cerrados por stage y existe una denegación explícita para certificados exportables.

Antes de cada despliegue se debe inventariar y conservar evidencia de los certificados ACM sin tags y volver a validar esas fronteras de confianza. Si el execution role se comparte, puede asumirse fuera de CloudFormation, un rol runtime obtiene ACM o deja de ser aceptable el inventario observado, el etiquetado debe migrarse a un mecanismo de provisión atómica o a una cuenta aislada antes de continuar.

El despliegue del frontend publica primero assets con hash y caché `immutable`, después punteros PWA sin caché, y `index.html` al final. S3 Versioning y la conservación de los manifiestos actual/anterior permiten republicar un SHA conocido.

## DNS

Los aliases `dev`, `test`, `api.dev`, `api.test` y el dominio del API productivo se modelan por ambiente según corresponda. El stack inicial **no administra** los registros de frontend productivo:

- A de `roadmap2u.com`: `162.241.62.201`;
- CNAME de `www.roadmap2u.com`: `roadmap2u.com`.

El cutover es una operación futura, separada y reversible; véase [runbooks/dns-cutover.md](runbooks/dns-cutover.md).

## Parámetros de integración

Cada despliegue publica valores no secretos en Parameter Store:

| Ruta | Contenido |
|---|---|
| `/roadmap2u/{stage}/region` | región AWS |
| `/roadmap2u/{stage}/user-pool-id` | ID del User Pool |
| `/roadmap2u/{stage}/user-pool-client-id` | ID del cliente web |
| `/roadmap2u/{stage}/api-base-url` | URL base sin `/v1` |
| `/roadmap2u/{stage}/frontend-bucket` | nombre del bucket privado |
| `/roadmap2u/{stage}/cloudfront-distribution-id` | ID de la distribución |
| `/roadmap2u/{stage}/frontend-url` | URL pública del frontend |
| `/roadmap2u/{stage}/contract-hash` | SHA-256 conjunto de los contratos |

El backend valida estos ocho parámetros después del deploy y los congela en un manifiesto inmutable por SHA. El frontend lee primero el pointer backend, después ese manifiesto y vuelve a leer el pointer antes de publicar; así nunca combina valores de dos despliegues concurrentes. Rechaza campos incompletos, una URL con `/v1` o un hash distinto al contrato fuente. Ningún valor se obtiene en runtime desde el navegador.

El proceso de publicación registra además manifiestos y marcadores operativos:

- `/roadmap2u/{stage}/backend-release-manifests/{sha}`: JSON inmutable con `schemaVersion=1`, stage, SHA backend y `handoff` con los ocho valores validados;
- `/roadmap2u/{stage}/backend-releases/{sha}`: evidencia de que el backend terminó deploy, validación y smokes;
- `/roadmap2u/{stage}/backend-release-sha`: SHA backend activo, escrito al final;
- `/roadmap2u/{stage}/frontend-releases/{sha}`: evidencia de que ese SHA terminó correctamente en el stage;
- `/roadmap2u/{stage}/frontend-release-sha`: SHA que se considera activo.

El manifiesto se crea después de los smokes y antes del marcador/pointer backend. Si ya existe para el SHA, solo se acepta si su JSON canónico coincide byte por byte; nunca se sobrescribe. Los marcadores sirven para exigir promociones y seleccionar un rollback conocido; no se adelantan a las validaciones de su release.

## Identidad de CI/CD

GitHub Actions solicita un token OIDC de vida corta y asume un rol IAM específico para repositorio y GitHub Environment. Backend y frontend no comparten rol; `dev`, `test` y `prod` usan roles, toolkits y assets separados. Las trust policies usan los IDs inmutables de owner y repositorio además del environment, por lo que un rename o namespace reciclado no hereda acceso. El proveedor OIDC existente se reutiliza y el stack de control se sintetiza sin depender del toolkit compartido. En una sola cuenta, el límite efectivo entre stages depende de las policies de sus `CloudFormationExecutionRole`; revisarlas es un gate obligatorio antes de activar deploy. Dos roles adicionales separan el corte DNS: `roadmap2u-prod-dns-plan`, de solo lectura y restringido al environment `prod`, prepara evidencia; `roadmap2u-prod-dns-cutover`, restringido a `prod-dns-cutover`, es el único que puede mutar los aliases tras la segunda aprobación. Ninguno es asumido por el deploy ordinario.

Los roles de despliegue no son secretos. Sus ARNs, el account ID y `HOSTED_ZONE_ID` son variables del GitHub Environment. No se usan access key ID ni secret access key permanentes.

## Ciclo de vida y guardas

- Pull request: checkout de ambos repositorios como hermanos, instalación reproducible, paridad byte a byte, typecheck, Vitest y synth de los tres stages.
- `main` o un dispatch manual del SHA exacto que encabeza `main` puede desplegar `dev` cuando `AWS_DEPLOY_ENABLED=true` y `AWS_ROLLBACK_ENABLED=false`.
- Promoción: `test` recibe un SHA exitoso de `dev`; `prod` recibe el mismo SHA exitoso de `test` y requiere aprobación.
- Rollback: requiere `AWS_DEPLOY_ENABLED=false`, `AWS_ROLLBACK_ENABLED=true` y un SHA exitoso previamente registrado en el mismo stage; ambos gates activos o ambos inactivos impiden el job.
- Cada despliegue ejecuta diff, deploy, validación de outputs/SSM y smoke tests.
- Ningún deploy ordinario modifica el DNS apex/`www` de producción.

## Riesgos que siguen siendo gates de go-live

La infraestructura no convierte en cerrados los siguientes pendientes de producto/operación: atomicidad de invitaciones y límites bajo concurrencia, mayor entropía de contraseñas temporales, purga de cuentas adultas y observabilidad/alertas operativas. El correo permanece en HostGator y Cognito default se limita al volumen de rollout/pruebas. También deben estar creadas y revisadas las policies de ejecución CloudFormation por stage. Deben resolverse o aceptarse explícitamente antes del go-live.
