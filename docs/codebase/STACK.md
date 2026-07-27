# Stack tecnológico

## 1. Resumen del runtime

| Área | Valor | Evidencia |
|------|-------|-----------|
| Lenguaje principal | TypeScript 5.7.3, modo estricto | `package-lock.json`, `tsconfig.json` |
| Runtime | Node.js 22; las Lambdas usan `NODEJS_22_X` | `.nvmrc`, `package.json`, `lib/roadmap-stack.ts` |
| Gestor de paquetes | npm 10.9.8 con lockfile v3 | `package.json`, `package-lock.json` |
| Módulos | ESM (`"type": "module"`), target ES2022 | `package.json`, `tsconfig.json` |
| Build de Lambdas | `NodejsFunction` + esbuild 0.25.12, salida ESM | `lib/roadmap-stack.ts`, `package-lock.json` |
| Infraestructura como código | AWS CDK v2 | `package.json`, `lib/roadmap-stack.ts` |
| Región soportada | `us-east-1` | `bin/roadmap.ts`, `lib/roadmap-stack.ts` |
| Ambientes | `dev`, `test`, `prod` | `bin/roadmap.ts`, `lib/roadmap-stack.ts` |

El repositorio no es un servidor Node tradicional: no levanta Express ni un
proceso permanente. CDK empaqueta tres entrypoints Lambda y AWS invoca cada uno
por eventos de API Gateway o Cognito.

## 2. Dependencias de producción

Las versiones exactas son las resueltas por `package-lock.json` y comprobadas
con `npm ls --depth=0`.

| Dependencia | Versión resuelta | Función |
|-------------|------------------|---------|
| `@aws-sdk/client-cognito-identity-provider` | 3.1080.0 | Administración de usuarios Cognito desde las Lambdas |
| `@aws-sdk/client-dynamodb` | 3.1080.0 | Cliente base de DynamoDB |
| `@aws-sdk/lib-dynamodb` | 3.1080.0 | Document client y comandos de persistencia |

No hay ORM, framework HTTP, cola, broker ni dependencia de logging en
producción. El router HTTP y la capa de persistencia están implementados en el
repositorio.

## 3. Toolchain de desarrollo

| Herramienta | Versión resuelta | Propósito | Evidencia |
|-------------|------------------|-----------|-----------|
| TypeScript | 5.7.3 | Typecheck estricto sin emitir archivos | `tsconfig.json` |
| AWS CDK CLI | 2.1129.0 | Synth, diff y deploy | `package-lock.json`, `cdk.json` |
| `aws-cdk-lib` | 2.261.0 | Constructs de infraestructura | `package-lock.json` |
| Constructs | 10.6.0 | Árbol de constructs CDK | `package-lock.json` |
| Vitest | 4.1.10 | 166 pruebas en entorno Node | `vitest.config.ts` |
| AWS SDK Client Mock | 4.1.0 | Dobles de DynamoDB/Cognito | `test/handlers.test.ts` |
| esbuild | 0.25.12 | Bundle de Lambdas vía CDK | `lib/roadmap-stack.ts` |
| tsx | 4.23.0 | Ejecutar el entrypoint CDK TypeScript | `cdk.json` |
| Prettier | Configuración presente, paquete no declarado | Formato esperado | `.prettierrc` |
| EditorConfig | N/A | UTF-8, dos espacios, LF final | `.editorconfig` |

No hay ESLint ni un comando `lint`. Tampoco hay dependencia o script de
Prettier en `package.json`; la configuración sirve a editores o a una
instalación externa.

## 4. Comandos principales

```powershell
npm ci
npm run typecheck
npm test
npm run check
npm run contracts:check
npm run contracts:hash
npm run synth -- -c stage=dev -c AWS_ACCOUNT_ID=... -c HOSTED_ZONE_ID=...
npm run diff -- -c stage=dev -c AWS_ACCOUNT_ID=... -c HOSTED_ZONE_ID=...
npm run deploy -- -c stage=dev -c AWS_ACCOUNT_ID=... -c HOSTED_ZONE_ID=...
```

`synth`, `diff` y `deploy` requieren un `stage` explícito, un account ID de 12
dígitos y el hosted zone ID. Conservar el repositorio o ejecutar tests no muta
AWS. Los despliegues autorizados se ejecutan desde workflows protegidos.

## 5. Configuración y variables

- Contextos CDK: `stage`, `AWS_ACCOUNT_ID`, `HOSTED_ZONE_ID`.
- Variables runtime de Lambda: `TABLE_NAME`, `USER_POOL_ID`.
- Ruta local opcional: `ROADMAP2U_FRONTEND_PATH`.
- Variables GitHub por environment: `AWS_ACCOUNT_ID`, `HOSTED_ZONE_ID`,
  `AWS_ROLE_ARN`; DNS usa además `DNS_PLAN_ROLE_ARN` y
  `DNS_CUTOVER_ROLE_ARN`.
- Gates de repositorio: `AWS_DEPLOY_ENABLED`, `AWS_ROLLBACK_ENABLED`,
  `DNS_CUTOVER_ENABLED`.
- No existe `.env.example`: el repositorio usa contexto CDK, variables de
  GitHub y credenciales temporales AWS.
- `cdk.out*`, `node_modules`, coverage y outputs CDK son artefactos
  ignorados; no forman parte de la arquitectura fuente.

## 6. Evidencia

- `package.json`
- `package-lock.json`
- `.nvmrc`
- `tsconfig.json`
- `cdk.json`
- `vitest.config.ts`
- `bin/roadmap.ts`
- `lib/roadmap-stack.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`
