# RoadMap2U backend

Infraestructura como código y backend serverless de RoadMap2U. Este repositorio es dueño de Cognito, API Gateway, Lambda, DynamoDB, hosting web en S3/CloudFront, certificados, DNS administrado por ambiente, parámetros SSM y la confianza OIDC usada por GitHub Actions.

> **Estado de esta entrega:** el código y los workflows quedan preparados, pero **no se ejecuta** `cdk bootstrap`, `cdk deploy`, una invalidación de CloudFront ni un cambio de Route 53. En particular, producción no administra todavía los registros `roadmap2u.com` ni `www.roadmap2u.com`.

## Ambientes

| Stage | Frontend | API | Orígenes CORS |
|---|---|---|---|
| `dev` | `https://dev.roadmap2u.com` | `https://api.dev.roadmap2u.com` | frontend dev y `localhost:4200/8826` |
| `test` | `https://test.roadmap2u.com` | `https://api.test.roadmap2u.com` | frontend test y `localhost:4200/8826` |
| `prod` | `https://roadmap2u.com` | `https://api.roadmap2u.com` | únicamente el apex productivo |

Todos los recursos se definen para `us-east-1`. El contexto `stage` es obligatorio y solo acepta `dev`, `test` o `prod`; los nombres físicos incluyen el stage para impedir cruces accidentales.

## Arquitectura

- Backend por stage: Cognito con inicio de sesión por username, HTTP API con authorizer JWT, Lambdas y una tabla DynamoDB.
- Hosting por stage: bucket S3 privado y versionado detrás de CloudFront con Origin Access Control (OAC), HTTPS, compresión, reescritura SPA y headers de seguridad.
- DNS y certificados: Route 53 y ACM. Los aliases de `dev` y `test` pueden gestionarse normalmente; el apex y `www` de producción quedan fuera del control inicial del stack.
- Entrega continua: GitHub Actions asume roles AWS por OIDC. No se guardan access keys permanentes en GitHub.
- Integración frontend/backend: los tres contratos TypeScript bajo `shared/` son copias exactas del frontend y se protegen con prueba de deriva y un hash conjunto.

El diseño detallado está en [docs/architecture.md](docs/architecture.md).

## Desarrollo local

Requisitos:

- Node.js 22 (véase `.nvmrc`).
- npm 10.9.8 (véase `packageManager` en `package.json`).
- Un checkout del frontend `RoadMap2U` junto a este repositorio para validar la paridad contractual.
- Credenciales AWS solo cuando un operador autorizado vaya a consultar o desplegar; no son necesarias para typecheck ni tests unitarios.

Instalación y verificaciones básicas:

```powershell
npm ci
npm run typecheck
npm test
```

El synth exige un stage explícito, el account ID y el hosted zone ID como contextos no sensibles. Nunca reutilices valores de otra cuenta o zona:

```powershell
npm run synth -- -c stage=dev -c AWS_ACCOUNT_ID=123456789012 -c HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ
npm run synth -- -c stage=test -c AWS_ACCOUNT_ID=123456789012 -c HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ
npm run synth -- -c stage=prod -c AWS_ACCOUNT_ID=123456789012 -c HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ
```

Estos comandos sintetizan plantillas; no despliegan recursos. Para el procedimiento autorizado de promoción y las validaciones posteriores, usa [docs/runbooks/deploy.md](docs/runbooks/deploy.md).

## Contratos compartidos

El frontend es la única fuente de verdad. No edites `shared/` a mano.

Con ambos repositorios como hermanos, comprueba la copia vendored:

```powershell
npm test -- test/contracts-parity.test.ts
node scripts/contracts-hash.mjs
```

Para sincronizar después de cambiar primero el frontend:

```powershell
node scripts/sync-contracts.mjs
```

Si el frontend está en otra ruta, define `ROADMAP2U_FRONTEND_PATH`. Consulta el ritual completo en [docs/contracts.md](docs/contracts.md).

## CI/CD y seguridad de despliegue

`.github/workflows/ci.yml` valida pull requests sin mutar AWS. `.github/workflows/deploy.yml` permanece bloqueado mientras `AWS_DEPLOY_ENABLED` no sea `true`. Cuando se habilite deliberadamente:

- `main` despliega `dev`;
- `test` y `prod` son promociones manuales del mismo SHA ya validado en el ambiente anterior;
- los jobs usan GitHub Environments y roles OIDC separados;
- los stacks de cada stage sintetizan contra un toolkit CDK con qualifier propio; su policy de ejecución de mínimo privilegio es un gate antes de habilitar deploy;
- producción exige aprobación y no cambia el DNS apex/`www`.

La preparación inicial está en [docs/github-aws-setup.md](docs/github-aws-setup.md). No copies credenciales AWS a Secrets, archivos `.env` ni variables del repositorio.

`.github/workflows/dns-cutover.yml` queda reservado para el corte futuro y tiene gates adicionales; no forma parte de un deploy ordinario ni se ejecuta en esta entrega.

## Protección del DNS productivo

Hasta ejecutar y aprobar el futuro cutover deben conservarse exactamente:

- `roadmap2u.com` → registro A `162.241.62.201`;
- `www.roadmap2u.com` → CNAME `roadmap2u.com`.

El procedimiento de captura, verificación, cambio y rollback está en [docs/runbooks/dns-cutover.md](docs/runbooks/dns-cutover.md). Nada en esta entrega lo ejecuta.

## Documentación

- [Arquitectura](docs/architecture.md)
- [Contrato funcional del backend](docs/backend-contract.md)
- [Contratos vendorizados y hash](docs/contracts.md)
- [Configuración GitHub ↔ AWS](docs/github-aws-setup.md)
- [Runbook de deploy y rollback](docs/runbooks/deploy.md)
- [Runbook futuro de corte DNS](docs/runbooks/dns-cutover.md)

## Licencia

[MIT](LICENSE).
