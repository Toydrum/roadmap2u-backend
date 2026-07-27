# Pruebas y calidad

## 1. Stack y comandos

- Runner: Vitest 4.1.10.
- Assertions/mocks: Vitest, `aws-cdk-lib/assertions`,
  `aws-sdk-client-mock`, procesos hijos y ejecutables falsos.
- Entorno: Node.
- Resultado verificado el 2026-07-27: **11 archivos, 166 pruebas, todas
  aprobadas**; `tsc --noEmit` también aprobó.

```powershell
npm run typecheck
npm test
npm run check
npm run contracts:check
npm test -- test/routes.test.ts
```

## 2. Organización

- Todos los archivos están bajo `test/`.
- Patrón: `test/**/*.test.ts`.
- No hay setup global.
- Cada suite importa explícitamente `describe`, `it`, `expect` y hooks.
- `vitest.config.ts` reproduce el alias `@app` de TypeScript.
- La prueba contractual requiere el checkout frontend hermano o
  `ROADMAP2U_FRONTEND_PATH`.

## 3. Qué prueba cada archivo

| Archivo | Alcance |
|---------|---------|
| `bin-config.test.ts` | Contexto obligatorio del entrypoint CDK |
| `bootstrap-template.test.ts` | CloudFormation bootstrap, MFA y scripts operativos |
| `ci-bootstrap.test.ts` | IAM/OIDC, boundaries y aislamiento por stage |
| `contracts-parity.test.ts` | Copias exactas y hash determinista |
| `handlers.test.ts` | Casos de uso, permisos, concurrencia y sync |
| `hosting.test.ts` | Recursos S3/CloudFront y función de edge |
| `infra.test.ts` | Template del backend Cognito/API/DynamoDB |
| `pre-signup.test.ts` | Trigger Cognito y validación de identidad |
| `routes.test.ts` | Cobertura bidireccional router ↔ contrato |
| `smoke-cleanup.test.ts` | Ejecución del script contra AWS CLI falso |
| `workflows.test.ts` | Gates y orden de workflows |

## 4. Matriz de alcance

| Alcance | Cobertura | Ejemplo | Notas |
|---------|-----------|---------|-------|
| Unitario | Sí | códigos, HTTP, route matching, handlers | Sin red |
| Persistencia simulada | Sí | DynamoDB/Cognito con mocks | No prueba semántica completa del servicio real |
| Infraestructura synth | Sí | CDK assertions | Valida CloudFormation sintetizado |
| Scripts operativos | Parcial | smoke cleanup y bootstrap invariants | AWS CLI falso/inspección textual |
| Workflow | Sí, estructural | gates, OIDC, orden | No ejecuta GitHub Actions localmente |
| Integración AWS real | No en Vitest | N/A | Ocurre en deploy/smokes |
| E2E backend desplegado | Parcial en workflow | TLS, CORS y 401 | No cubre todos los flujos autenticados |

## 5. Mocks y aislamiento

- `Deps` inyecta document clients, Cognito, tabla, pool y reloj.
- `aws-sdk-client-mock` intercepta comandos reales del SDK.
- CDK `App`/`Template` se crea por test sin cuenta AWS.
- Scripts usan directorios temporales y un ejecutable `aws` controlado.
- Workflows/documentación se leen como texto para fijar invariantes críticas.
- La suite no necesita credenciales AWS.
- El frontend real sí se necesita para la prueba de paridad.

## 6. Cobertura y señales

- Coverage tool/threshold: `[TODO]` no configurado.
- Coverage report actual: `[TODO]`.
- CI ejecuta paridad, typecheck, 166 tests y synth de `dev/test/prod`.
- No se encontraron tests marcados como skipped en la salida ejecutada.
- Los archivos de mayor churn son tests de IAM/bootstrap, señal de que las
  políticas y la operación han sido la zona más cambiante.

Brechas relevantes:

- No hay test live de DynamoDB para `BatchWrite` con `UnprocessedItems`.
- No hay test de `queryPrefix` atravesando varias páginas.
- Los smokes del backend desplegado se concentran en TLS/CORS/401.
- No hay load/performance tests.
- No hay verificación automatizada de alarmas porque no existen alarmas.

## 7. Evidencia

- `vitest.config.ts`
- `package.json`
- `test/`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`
- Salida local: `tsc --noEmit` aprobado; Vitest 11/11 y 166/166.
