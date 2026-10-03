# Integraciones externas

## 1. Inventario

| Sistema | Tipo | Propósito | Autenticación | Criticidad | Evidencia |
|---------|------|-----------|---------------|------------|-----------|
| Amazon Cognito | Identidad | Signup/login, recuperación y menores | SRP/JWT; admin IAM desde Lambda | Alta | `lib/roadmap-stack.ts`, `lambda/handlers/family.ts` |
| API Gateway HTTP API | API | Exponer `/v1/{proxy+}` | Authorizer JWT Cognito | Alta | `lib/roadmap-stack.ts` |
| AWS Lambda | Compute | Triggers y router serverless | Roles IAM con boundary | Alta | `lib/roadmap-stack.ts` |
| DynamoDB | Base de datos | Perfiles, relaciones y sync | IAM por Lambda | Alta | `lambda/db.ts` |
| S3 | Objetos | Hosting PWA privado y assets CDK | OAC/IAM | Alta | `lib/roadmap-stack.ts` |
| CloudFront | CDN | HTTPS, caché, SPA y redirect | OAC hacia S3 | Alta | `lib/roadmap-stack.ts` |
| Route 53 | DNS | Dominios API/dev/test y cutover prod | Roles IAM separados | Alta | `lib/roadmap-stack.ts`, workflow DNS |
| ACM | Certificados | TLS de API y frontend | CloudFormation/IAM | Alta | `lib/roadmap-stack.ts` |
| SSM Parameter Store | Config/release registry | Handoff frontend y pruebas de promoción | IAM por repo/stage | Alta | `lib/roadmap-stack.ts`, workflow deploy |
| CloudWatch Logs | Observabilidad | Logs Lambda y access logs API | IAM/log delivery | Media | `lib/roadmap-stack.ts` |
| GitHub Actions | CI/CD | CI, deploy, promoción, rollback, DNS | OIDC temporal | Alta | `.github/workflows/` |
| Frontend `RoadMap2U` | Contrato externo | Fuente normativa de tres archivos | Checkout GitHub/paridad local | Alta | `docs/contracts.md` |
| HostGator | Correo/DNS externo | Buzones y registros de correo permanecen fuera | Fuera del stack | Media | `docs/architecture.md` |

No hay Kafka, SQS, SNS, EventBridge, RabbitMQ, Redis, RDS, SES, servicio mesh
ni API externa de aplicación.

## 2. Almacenes

| Almacén | Rol | Acceso | Protección |
|---------|-----|--------|------------|
| DynamoDB `roadmap-{stage}` | Datos de dominio y change feed | `lambda/db.ts` | On-demand, TTL, dos GSIs; PITR/deletion protection en prod |
| Cognito User Pool | Credenciales e identidad | SDK Cognito y triggers | Deletion protection en prod |
| S3 `roadmap2u-{stage}-{account}` | Build PWA | CloudFront OAC y rol frontend | Privado, SSL, cifrado S3, versioning |
| SSM `/roadmap2u/{stage}/...` | Config no secreta y releases | Workflows/CloudFormation | Scopes IAM por path |
| Bucket bootstrap CDK | Templates/assets | Roles toolkit | Separado por qualifier/stage |

El navegador no consulta SSM. El frontend recibe configuración durante su
pipeline y valida el hash contractual antes de publicar.

## 3. Secretos y credenciales

- GitHub obtiene credenciales temporales con OIDC; no hay access keys
  permanentes en el repositorio ni referencias a GitHub Secrets.
- Los roles confían en owner ID, repository ID y GitHub Environment, no sólo en
  nombres mutables.
- Los scripts operativos asumen roles con MFA y restauran las variables de
  credenciales al terminar.
- Account IDs, hosted zone IDs y ARNs aparecen en código/scripts. No son
  secretos, pero hacen que el bootstrap sea deliberadamente específico para
  una cuenta.
- `.gitignore` excluye `.env` y `.env.*`.
- Runtime recibe nombres de recursos como `TABLE_NAME`, `USER_POOL_ID` y
  `ACCESS_CODE_PARAMETER_NAME`; no recibe valores secretos por environment.
- El keyring HMAC de accesos patrocinados vive en SSM Parameter Store como
  Standard `SecureString`. Sólo broker y canjeador pueden ejecutar
  `ssm:GetParameter` sobre el parámetro exacto de su stage. El CLI de migración
  valida primero con STS la cuenta `765932874577` y rechaza keyrings mayores a
  4 KiB antes de leer o escribir el destino Standard. `migrate` conserva el
  secreto existente en cualquier stage; `initialize` sólo continúa en `test` o
  `prod` después de comprobar con `DescribeSecret` que no hay origen previo.

## 4. Confiabilidad y fallos

- AWS SDK conserva su comportamiento estándar de reintentos; el código no
  configura una política propia.
- API router: timeout 15 s; triggers Cognito: 10 s.
- Friendships y reserva de username usan transacciones/condiciones.
- Sync usa conditional puts y devuelve el ganador en conflictos.
- Códigos y requests usan TTL y rate limiting.
- Deploy verifica estado CloudFormation, TLS, CORS, ocho parámetros y logs.
- Producción retiene identidad, datos y objetos; S3 usa versioning.
- Los releases se identifican por SHA y manifiesto SSM inmutable.
- DNS usa plan/apply, checksum, drift check y batch de rollback.
- No existe circuit breaker.
- Algunos flujos multi-step siguen sin ser completamente atómicos; véase
  `CONCERNS.md`.

## 5. Observabilidad

Implementado:

- Log groups explícitos por Lambda con retención 7/14/30 días.
- Access logs API con request ID, route, status, response length y latency.
- Smoke tests post-deploy.
- Evidencia de deploy y DNS mediante SSM/artefactos.

Ausente:

- CloudWatch Alarms.
- Métricas de negocio o custom metrics.
- Tracing/X-Ray.
- Dashboard, paging y alertas.
- Correlation ID propagado por las capas de aplicación.

La propia documentación marca observabilidad/alertas como gate de go-live.

## 6. Evidencia

- `docs/architecture.md`
- `docs/github-aws-setup.md`
- `lib/roadmap-stack.ts`
- `lib/stage-policies.ts`
- `lambda/db.ts`
- `lambda/handlers/family.ts`
- `.github/workflows/deploy.yml`
- `.github/workflows/dns-cutover.yml`
- `scripts/aws-bootstrap.ps1`
